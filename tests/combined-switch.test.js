'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.BRIDGE_VOICE_BACKEND = 'teamspeak-mumble';
process.env.BRIDGE_COMMAND_PREFIX = '!wa';
process.env.BRIDGE_COMMANDER_UIDS = 'ts-commander,cert-hash';
process.env.TS3_CLIENTQUERY_API_KEY = 'fixture-only';

const { COMMANDER_UIDS } = require('../bot/config');
const { extractCommand, handleCommand } = require('../bot/commands');
const { runMumbleCommandBot } = require('../bot/mumble/command-listener');
const { NativeMumbleClient } = require('../bot/mumble/native');
const state = require('../bot/state');
const { ClientQuery } = require('../bot/teamspeak/client-query');
const { runTeamSpeakCommandListener } = require('../bot/teamspeak/command-listener');
const { parseArgs } = require('../bot/util');

function runSwitch(message) {
    return handleCommand({}, parseArgs(extractCommand(message)));
}

test('switch is explicit and disabled when the commander allowlist is empty', async (t) => {
    const commanders = [...COMMANDER_UIDS];
    COMMANDER_UIDS.clear();
    t.after(() => commanders.forEach((id) => COMMANDER_UIDS.add(id)));
    assert.equal(extractCommand('switch mumble Lobby'), null);
    assert.doesNotMatch(await handleCommand({}, ['help']), /!wa switch/);
    await assert.rejects(runSwitch('!wa switch mumble Lobby'), /requires a configured BRIDGE_COMMANDER_UIDS/);
});

test('both listeners verify sender identity and move only the named backend', async (t) => {
    const moves = [];
    const tsReplies = [];
    const mumbleReplies = [];
    let query;
    let native;
    t.after(() => {
        state.clientQuery = null;
        state.voiceChannels = {};
    });
    t.mock.method(ClientQuery.prototype, 'connect', async function () {
        query = this;
        this.socket = { destroyed: false };
        this.closed = new Promise(() => {});
    });
    t.mock.method(ClientQuery.prototype, 'reply', async (event, text) => tsReplies.push(text));
    t.mock.method(ClientQuery.prototype, 'listSwitchableChannels', async () => [
        { id: '12', name: 'Desk TS' },
    ]);
    t.mock.method(ClientQuery.prototype, 'moveSelfToChannel', async ({ id }, options) =>
        moves.push(['teamspeak', id, options.allowReconnect]));
    t.mock.method(NativeMumbleClient.prototype, 'run', async function () { native = this; });
    t.mock.method(NativeMumbleClient.prototype, 'request', async (op, args) => {
        if (op === 'channels') return [{ id: 21, name: 'Desk Mumble' }];
        if (op === 'move') return moves.push(['mumble', args.channel]);
        assert.equal(op, 'send_text');
        mumbleReplies.push(args.text);
    });

    runTeamSpeakCommandListener({});
    await runMumbleCommandBot({});
    await query.onTextMessage({ invokeruid: 'stranger', msg: '!wa switch mumble "Desk Mumble"' });
    native.emit('text', {
        actor: 9, message: '!wa switch teamspeak "Desk TS"',
        user: { hash: 'stranger' }, private: false,
    });
    await new Promise(setImmediate);
    assert.match(tsReplies[0], /not allowed/);
    assert.match(mumbleReplies[0], /not allowed/);
    assert.deepEqual(moves, []);

    await query.onTextMessage({ invokeruid: 'ts-commander', msg: '!wa switch mumble "desk mumble"' });
    assert.deepEqual(moves, [['mumble', 21]]);
    assert.equal(tsReplies[1], 'Switched Mumble channel to: Desk Mumble');
    native.emit('text', {
        actor: 9, message: '!wa switch TeamSpeak Desk TS',
        user: { hash: 'cert-hash' }, private: false,
    });
    await new Promise(setImmediate);
    assert.deepEqual(moves, [['mumble', 21], ['teamspeak', '12', false]]);
    assert.equal(mumbleReplies[1], 'Switched TeamSpeak channel to: Desk TS');
});

test('overlapping room switches serialize per backend and recover after a rejected move', async (t) => {
    t.after(() => { state.voiceChannels = {}; });
    const events = [];
    let releaseFirst;
    const firstMove = new Promise((resolve) => { releaseFirst = resolve; });
    state.voiceChannels.mumble = {
        listSwitchableChannels: async () => [
            { id: 1, name: 'First' }, { id: 2, name: 'Second' },
            { id: 3, name: 'Duplicate' }, { id: 4, name: 'duplicate' },
        ],
        moveToChannel: async ({ id }) => {
            events.push(id);
            if (id === 1) {
                await firstMove;
                throw new Error('move rejected');
            }
        },
    };
    state.voiceChannels.teamspeak = {
        listSwitchableChannels: async () => [{ id: '12', name: 'Other' }],
        moveToChannel: async ({ id }) => events.push(id),
    };
    await assert.rejects(runSwitch('!wa switch'), /Usage/);
    await assert.rejects(runSwitch('!wa switch unknown First'), /Usage/);
    await assert.rejects(runSwitch('!wa switch mumble First-ish'), /not found/);
    await assert.rejects(runSwitch('!wa switch mumble duplicate'), /ambiguous/);
    const failed = assert.rejects(runSwitch('!wa switch mumble First'), /move rejected/);
    const queued = runSwitch('!wa switch mumble Second');
    await runSwitch('!wa switch teamspeak Other');
    assert.deepEqual(events, [1, '12']);
    releaseFirst();
    await failed;
    assert.equal(await queued, 'Switched Mumble channel to: Second');
    assert.deepEqual(events, [1, '12', 2]);
});

test('an unconfirmed TeamSpeak move never reconnects when called from combined chat', async (t) => {
    const query = new ClientQuery();
    t.mock.method(query, 'getOwnClientInfo', async () => ({ clid: '2', cid: '10' }));
    const sent = [];
    t.mock.method(query, 'command', async (line) => sent.push(line));
    const reconnect = t.mock.method(query, 'reconnectToChannel', async () => {});
    const channel = { id: '12', name: 'Desk TS' };
    await assert.rejects(query.moveSelfToChannel(channel, { allowReconnect: false }), /still reports current channel/);
    assert.deepEqual(sent, ['clientmove cid=12 clid=2']);
    assert.equal(reconnect.mock.callCount(), 0);
});
