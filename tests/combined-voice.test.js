'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.BRIDGE_VOICE_BACKEND = 'teamspeak-mumble';
process.env.BRIDGE_MUMBLE_CLIENT = 'gui'; // combined always selects native
process.env.TS3_CLIENTQUERY_API_KEY = 'test';
process.env.BRIDGE_COMMANDER_UIDS = 'ts-user,cert-hash';

const state = require('../bot/state');
const { ClientQuery } = require('../bot/teamspeak/client-query');
const { teamSpeakChannels } = require('../bot/teamspeak/channels');
const { parseTsLine } = require('../bot/teamspeak/protocol');
const { NativeMumbleClient } = require('../bot/mumble/native');
const { mumbleHtmlToText } = require('../bot/mumble/client');
const { handleWhatsAppMessage } = require('../bot/whatsapp/messages');

test('both listeners authorize, serialize call starts, and reply on the originating server', async (t) => {
    t.mock.method(require('../bot/audio/pulse'), 'refreshWhatsAppMicrophone', async () => {});
    t.mock.method(require('../bot/whatsapp/microphone'), 'scheduleWhatsAppCallMicrophoneStabilization', () => {});
    const { runTeamSpeakCommandListener } = require('../bot/teamspeak/command-listener');
    const { runMumbleCommandBot } = require('../bot/mumble/command-listener');
    const tsReplies = [], mumbleReplies = [], starts = [], adds = [];
    let ts, mumble, active;
    t.mock.method(ClientQuery.prototype, 'connect', async function () {
        ts = this;
        this.closed = new Promise(() => {});
    });
    t.mock.method(ClientQuery.prototype, 'reply', async (event, text) => tsReplies.push(text));
    t.mock.method(NativeMumbleClient.prototype, 'run', async function () { mumble = this; });
    t.mock.method(NativeMumbleClient.prototype, 'request', async (op, args) => {
        assert.equal(op, 'send_text');
        mumbleReplies.push(args.text);
    });
    let releaseCall;
    const starting = new Promise((resolve) => { releaseCall = resolve; });
    const client = {
        pupPage: { evaluate: async () => 'native', isClosed: () => false },
        getActiveCall: async () => active,
        call: async (contact) => {
            starts.push(contact);
            await starting;
            active = { id: 'call-1' };
            return active;
        },
        addParticipantToCall: async (...args) => adds.push(args),
    };
    runTeamSpeakCommandListener(client);
    await runMumbleCommandBot(client);
    assert.ok(state.voiceChannels.mumble && state.voiceChannels.teamspeak);
    const tsSend = (msg, uid = 'ts-user') => ts.onTextMessage({ msg, invokeruid: uid });
    const mumbleSend = (message, hash = 'cert-hash') => mumble.emit('text', {
        message, actor: 7, private: false, user: { hash },
    });
    await tsSend('hello');
    mumbleSend('hello');
    assert.deepEqual([tsReplies, mumbleReplies], [[], []]);
    await tsSend('!wa hangup', 'other-ts-user');
    mumbleSend('!wa hangup', 'other-hash');
    assert.match(tsReplies[0], /not allowed/);
    assert.match(mumbleReplies[0], /not allowed/);

    // A failed mutation must also release the shared queue.
    await tsSend('!wa hangup');
    assert.match(tsReplies[1], /No active/);
    const first = tsSend('!wa call +491701234560');
    mumbleSend('!wa call +491701234561');
    await new Promise(setImmediate);
    assert.deepEqual(starts, ['491701234560@c.us']);
    assert.deepEqual(adds, []);
    releaseCall();
    await first;
    await new Promise(setImmediate);
    assert.equal(starts.length, 1);
    assert.deepEqual(adds, [['491701234561@c.us', 'call-1']]);
    assert.match(tsReplies[2], /Started WhatsApp/);
    assert.match(mumbleReplies[1], /invited 1/);
});

test('WhatsApp channel commands give operator guidance for polls and named moves', async () => {
    const replies = [];
    for (const body of ['!switchChannel', '!switchChannel Lobby', 'ordinary chat']) {
        await handleWhatsAppMessage({}, { body, from: 'test', reply: async (text) => replies.push(text) });
    }
    assert.equal(replies.length, 2);
    for (const reply of replies) assert.match(reply, /move the bridge user.*TeamSpeak or Mumble/);
    assert.equal(state.channelPolls.size, 0);
});

test('announcements follow each server channel independently during a call', async (t) => {
    const { startCallAnnouncements } = require('../bot/whatsapp/call-announcements');
    const received = [];
    let tsRoom = 1, mumbleRoom = 2, count = 2, tick;
    state.clientQuery = new ClientQuery();
    state.clientQuery.socket = { destroyed: false };
    t.mock.method(state.clientQuery, 'command', async (line) => {
        if (line === 'whoami') return [`clid=7 cid=${tsRoom}`, 'error id=0 msg=ok'];
        assert.match(line, /^sendtextmessage targetmode=2 /);
        const { target, msg } = parseTsLine(line);
        received.push([Number(target), msg]);
        return ['error id=0 msg=ok'];
    });
    const native = new NativeMumbleClient({});
    t.mock.method(native, 'request', async (op, { text }) => {
        assert.equal(op, 'send_channel');
        received.push([mumbleRoom, mumbleHtmlToText(text)]);
    });
    state.voiceChannels = { teamspeak: teamSpeakChannels, mumble: native };
    state.ready = true;
    t.mock.method(global, 'setInterval', (fn) => { tick = fn; return { unref() {} }; });
    startCallAnnouncements({
        getActiveCall: async () => ({ id: 'live' }), getActiveCallParticipantCount: async () => count,
    });
    for (let i = 0; i < 3; i++) {
        await tick();
        await tick();
        if (i === 0) tsRoom = 3;
        else mumbleRoom = 4;
        count++;
    }
    for (const [index, expected] of [[0, [1, 2]], [2, [2, 3]], [4, [3, 4]]]) {
        const pair = received.slice(index, index + 2);
        assert.deepEqual(pair.map(([room]) => room).sort(), expected);
        assert.equal(pair[0][1], pair[1][1]);
    }
});
