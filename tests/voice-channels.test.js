'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const test = require('node:test');
const { createMumbleChannelControl, isMoveDenial } = require('../bot/mumble/channels');
const { VOICE_BACKEND } = require('../bot/config');
const state = require('../bot/state');
const { switchToChannelByName } = require('../bot/voice-channels');

// Mimics the parts of MumbleClient the channel control uses. The "server"
// answers a move with `respond(session, channelId)`.
function createFakeMumble(respond) {
    const mumble = new EventEmitter();
    mumble.synced = true;
    mumble.socket = { destroyed: false };
    mumble.closed = new Promise(() => {});
    mumble.channels = new Map([
        [0, { id: 0, parent: undefined, name: '' }],
        [1, { id: 1, parent: 0, name: 'Bridge' }],
        [2, { id: 2, parent: 0, name: 'Lobby' }],
    ]);
    mumble.users = new Map([
        [10, { session: 10, name: 'WhatsAppBridge', channelId: 1 }],
        [11, { session: 11, name: 'WhatsAppBridge-Bot', channelId: 1 }],
    ]);
    mumble.session = 11;
    mumble.moves = [];
    mumble.texts = [];
    mumble.sendTextMessage = (message) => mumble.texts.push(message);
    mumble.findUserByName = (name) =>
        [...mumble.users.values()].find(
            (user) => user.session !== mumble.session && user.name.toLowerCase() === name.toLowerCase(),
        );
    mumble.channelName = (id) => {
        const channel = mumble.channels.get(id);
        return channel ? channel.name || 'Root' : `#${id}`;
    };
    mumble.moveUserToChannel = (session, channelId) => {
        mumble.moves.push([session, channelId]);
        setImmediate(() => respond(mumble, session, channelId));
    };
    return mumble;
}

const acceptMove = (mumble, session, channelId) => {
    const user = mumble.users.get(session);
    user.channelId = channelId;
    mumble.emit('userState', user, { created: false, movedChannel: true });
};

function control(mumble, extra = {}) {
    return createMumbleChannelControl({
        getClient: () => mumble,
        bridgeUsername: 'WhatsAppBridge',
        botUsername: 'WhatsAppBridge-Bot',
        ...extra,
    });
}

test('Mumble channel list excludes the bridge user\'s channel and names the root', async () => {
    const channels = await control(createFakeMumble(acceptMove)).listSwitchableChannels();
    assert.deepStrictEqual(
        channels.map((channel) => [channel.id, channel.name]),
        [
            [0, 'Root'],
            [2, 'Lobby'],
        ],
    );
});

test('Mumble move targets the bridge user and resolves on server confirmation', async () => {
    const mumble = createFakeMumble(acceptMove);
    await control(mumble).moveToChannel({ id: 2, name: 'Lobby' });
    assert.deepStrictEqual(mumble.moves, [[10, 2]]);
    assert.strictEqual(mumble.users.get(10).channelId, 2);
    assert.strictEqual(mumble.listenerCount('closed'), 0, 'successful moves release close listeners');
});

test('Mumble move denial explains the missing Move permission', async () => {
    const mumble = createFakeMumble((fake) =>
        fake.emit('permissionDenied', { type: 1, permission: 0x20, channelId: 1 }),
    );
    await assert.rejects(
        control(mumble).moveToChannel({ id: 2, name: 'Lobby' }),
        /denied moving the bridge to Lobby.*"WhatsAppBridge-Bot".*Move permission/,
    );
    assert.strictEqual(mumble.listenerCount('userState'), 0, 'listeners are removed');
    assert.strictEqual(mumble.listenerCount('closed'), 0);
});

test('Mumble move rejects on disconnect and removes all move listeners', async () => {
    const mumble = createFakeMumble((fake) => fake.emit('closed', 'connection lost'));
    await assert.rejects(control(mumble).moveToChannel({ id: 2, name: 'Lobby' }), /connection lost/);
    for (const event of ['userState', 'permissionDenied', 'closed']) {
        assert.strictEqual(mumble.listenerCount(event), 0);
    }
});

test('Mumble move times out without a server answer', async () => {
    const mumble = createFakeMumble(() => {});
    await assert.rejects(
        control(mumble, { moveTimeoutMs: 50 }).moveToChannel({ id: 2, name: 'Lobby' }),
        /did not confirm the move to Lobby/,
    );
});

test('Mumble channel control reports missing preconditions', async () => {
    const mumble = createFakeMumble(acceptMove);
    await assert.rejects(
        control(mumble, { bridgeUsername: '' }).listSwitchableChannels(),
        /MUMBLE_URI must include the bridge username/,
    );
    await assert.rejects(
        control(mumble, { bridgeUsername: 'Nobody' }).listSwitchableChannels(),
        /bridge user Nobody is not connected/,
    );
    await assert.rejects(
        control(createFakeMumble(acceptMove), { getClient: () => null }).listSwitchableChannels(),
        /command bot is not connected/,
    );
});

test('Mumble channel messages go to the bridge user\'s channel, else the bot\'s', async () => {
    const mumble = createFakeMumble(acceptMove);
    mumble.users.get(10).channelId = 2;
    mumble.self = mumble.users.get(11);
    await control(mumble).sendChannelMessage('hello');
    await control(mumble, { bridgeUsername: '' }).sendChannelMessage('fallback');
    assert.deepStrictEqual(mumble.texts, [
        { channelIds: [2], text: 'hello' },
        { channelIds: [1], text: 'fallback' },
    ]);
});

test('TeamSpeak channel messages target the bridge client\'s current channel', async () => {
    const { ClientQuery } = require('../bot/teamspeak/client-query');
    const query = new ClientQuery();
    const sent = [];
    query.command = async (text) => {
        sent.push(text);
        return text === 'whoami' ? ['clid=7 cid=42', 'error id=0 msg=ok'] : ['error id=0 msg=ok'];
    };
    await query.sendChannelMessage('📞 Someone joined the WhatsApp call (2 on WhatsApp).');
    assert.deepStrictEqual(sent, [
        'whoami',
        'sendtextmessage targetmode=2 target=42 msg=📞\\sSomeone\\sjoined\\sthe\\sWhatsApp\\scall\\s(2\\son\\sWhatsApp).',
    ]);
});

test('only move-related permission denials count as move failures', () => {
    assert.strictEqual(isMoveDenial({ type: 1, permission: 0x20 }), true);
    assert.strictEqual(isMoveDenial({ type: 1, permission: 0x4 }), true);
    assert.strictEqual(isMoveDenial({ type: 9 }), true);
    assert.strictEqual(isMoveDenial({ type: 1, permission: 0x200 }), false);
    assert.strictEqual(isMoveDenial({ type: 4 }), false);
});

test('switchToChannelByName uses the registered backend and matches names exactly', async () => {
    const moved = [];
    const previous = state.voiceChannels[VOICE_BACKEND];
    state.voiceChannels[VOICE_BACKEND] = {
        listSwitchableChannels: async () => [
            { id: 2, name: 'Lobby' },
            { id: 3, name: 'Talk' },
            { id: 4, name: 'talk' },
        ],
        moveToChannel: async (channel) => moved.push(channel.id),
    };
    try {
        assert.deepStrictEqual(await switchToChannelByName('lobby'), { id: 2, name: 'Lobby' });
        assert.deepStrictEqual(moved, [2]);
        await assert.rejects(switchToChannelByName('Talk'), /ambiguous/);
        await assert.rejects(switchToChannelByName('Lob'), /not found or already active/);

        state.voiceChannels[VOICE_BACKEND] = null;
        await assert.rejects(switchToChannelByName('Lobby'), /channel switching is not available/);
    } finally {
        state.voiceChannels[VOICE_BACKEND] = previous;
    }
});
