'use strict';

const assert = require('assert');
const test = require('node:test');
const { createChatRelay, stripTeamSpeakBbcode, truncateBytes } = require('../bot/chat-relay');

function setup(overrides = {}) {
    const sent = { teamspeak: [], mumble: [] };
    const errors = [];
    const senders = {
        teamspeak: { sendChannelMessage: async (text) => { sent.teamspeak.push(text); } },
        mumble: { sendChannelMessage: async (text) => { sent.mumble.push(text); } },
        ...overrides,
    };
    const relay = createChatRelay({
        commandPrefix: '!wa',
        getSender: (target) => senders[target],
        log: { error: (message) => errors.push(message) },
    });
    return { relay, sent, errors };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('TeamSpeak channel chat reaches Mumble with a source prefix', async () => {
    const { relay, sent } = setup();
    relay.fromTeamSpeak({ targetmode: '2', invokerid: '5', invokername: 'Alice', msg: 'hi there' }, { ownClientId: '9' });
    await settle();
    assert.deepStrictEqual(sent, { teamspeak: [], mumble: ['[TS] Alice: hi there'] });
});

test('Mumble channel chat reaches TeamSpeak as plain text', async () => {
    const { relay, sent } = setup();
    relay.fromMumble({ private: false, user: { name: 'Bob' }, message: '<p>a &amp; b<br>c</p>' });
    await settle();
    assert.deepStrictEqual(sent, { teamspeak: ['[Mumble] Bob: a & b c'], mumble: [] });
});

test('private, server, own, command and empty messages are not relayed', async () => {
    const { relay, sent } = setup();
    const own = { ownClientId: '9' };
    relay.fromTeamSpeak({ targetmode: '1', invokerid: '5', invokername: 'A', msg: 'x' }, own);
    relay.fromTeamSpeak({ targetmode: '3', invokerid: '5', invokername: 'A', msg: 'x' }, own);
    relay.fromTeamSpeak({ targetmode: '2', invokerid: '9', invokername: 'Bridge', msg: 'x' }, own);
    relay.fromTeamSpeak({ targetmode: '2', invokerid: '5', invokername: 'A', msg: 'x' }, {});
    relay.fromTeamSpeak({ targetmode: '2', invokerid: '5', invokername: 'A', msg: '!wa status' }, own);
    relay.fromTeamSpeak({ targetmode: '2', invokerid: '5', invokername: 'A', msg: '   ' }, own);
    relay.fromMumble({ private: true, user: { name: 'B' }, message: 'x' });
    relay.fromMumble({ private: false, user: { name: 'B' }, message: '!wa call 123' });
    relay.fromMumble({ private: false, user: { name: 'B' }, message: '<img src="data:image/png;base64,AAAA"/>' });
    await settle();
    assert.deepStrictEqual(sent, { teamspeak: [], mumble: [] });
});

test('a word that merely starts with the prefix is still relayed', async () => {
    const { relay, sent } = setup();
    relay.relay('mumble', 'B', '!wallpaper is nice');
    await settle();
    assert.deepStrictEqual(sent.teamspeak, ['[Mumble] B: !wallpaper is nice']);
});

test('TeamSpeak BBCode is stripped before relaying', () => {
    assert.strictEqual(stripTeamSpeakBbcode('[URL]https://x.test[/URL] [b]bold[/b]'), 'https://x.test bold');
    assert.strictEqual(stripTeamSpeakBbcode('[URL=https://x.test]site[/URL]'), 'site (https://x.test)');
});

test('long and multi-byte text is truncated on a character boundary', () => {
    const text = truncateBytes('é'.repeat(1000), 900);
    assert.ok(Buffer.byteLength(text) <= 900);
    assert.ok(text.endsWith('...'));
    assert.ok(!text.includes('�'));
    assert.strictEqual(truncateBytes('😀'.repeat(400), 100).includes('�'), false);
});

test('messages keep their order within a direction', async () => {
    const order = [];
    const { relay } = setup({
        teamspeak: { sendChannelMessage: async (text) => {
            await new Promise((resolve) => setTimeout(resolve, text.endsWith('1') ? 15 : 0));
            order.push(text);
        } },
    });
    for (const n of [1, 2, 3]) relay.relay('mumble', 'B', `m${n}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepStrictEqual(order, ['[Mumble] B: m1', '[Mumble] B: m2', '[Mumble] B: m3']);
});

test('a flood is capped and send failures never reject or throw', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delivered = [];
    const { relay, errors } = setup({
        teamspeak: { sendChannelMessage: async (text) => { await gate; delivered.push(text); } },
    });
    for (let i = 0; i < 30; i += 1) relay.relay('mumble', 'B', `m${i}`);
    release();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(delivered.length, 8);
    assert.strictEqual(errors.length, 1);

    const failing = setup({ mumble: { sendChannelMessage: async () => { throw new Error('boom'); } } });
    failing.relay.relay('teamspeak', 'A', 'x');
    const missing = setup({ mumble: undefined });
    missing.relay.relay('teamspeak', 'A', 'x');
    await settle();
    assert.match(failing.errors[0], /to Mumble failed: boom/);
    assert.match(missing.errors[0], /not available/);
});
