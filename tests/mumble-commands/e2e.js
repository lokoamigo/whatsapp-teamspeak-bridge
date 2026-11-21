'use strict';

// End-to-end test of the Mumble command bot against a real Mumble server.
// Started by run.sh, which provides the server in Docker.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    MessageType,
    MumbleClient,
    encodeMessage,
    ensureClientCertificate,
    mumbleHtmlToText,
} = require('../../bot/mumble/client');
const { createMumbleChannelControl } = require('../../bot/mumble/channels');
const { createMumbleCommandBot, getMumbleBotConfig } = require('../../bot/mumble/commands');

const HOST = process.env.MUMBLE_TEST_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.MUMBLE_TEST_PORT || '64738', 10);
const SUPERUSER_PASSWORD = process.env.MUMBLE_TEST_SUPERUSER_PASSWORD;
const PREFIX = '!wa';
const BARE = new Set(['help', 'status', 'call']);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mumble-e2e-'));
const acceptAnyServer = () => ({ trusted: true });

async function waitFor(description, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for: ${description}`);
}

async function connectUser(username, options = {}) {
    const client = new MumbleClient({
        host: HOST,
        port: PORT,
        username,
        verifyServer: acceptAnyServer,
        ...options,
    });
    client.replies = [];
    client.on('textMessage', (event) => client.replies.push(mumbleHtmlToText(event.message)));
    await client.connect();
    return client;
}

async function expectReply(client, send, expected) {
    const before = client.replies.length;
    send();
    const reply = await waitFor(`reply matching ${expected}`, () => client.replies[before]);
    assert.match(reply, expected);
    return reply;
}

async function expectNoReply(client, send) {
    const before = client.replies.length;
    send();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.strictEqual(client.replies.length, before, `unexpected reply: ${client.replies[before]}`);
}

const logs = [];

async function main() {
    const log = {
        log: (line) => logs.push(line),
        error: (line) => logs.push(`ERROR ${line}`),
    };
    let pass = 0;
    const step = (name) => {
        pass += 1;
        console.log(`PASS: ${name}`);
    };

    const admin = await connectUser('SuperUser', { password: SUPERUSER_PASSWORD });
    for (const name of ['Bridge', 'Other']) {
        admin.send(MessageType.ChannelState, encodeMessage([[2, 0], [3, name]]));
    }
    const bridgeChannel = await waitFor('Bridge channel', () => admin.findChannelByPath(['Bridge']));
    const otherChannel = await waitFor('Other channel', () => admin.findChannelByPath(['Other']));

    const commanderIdentity = await ensureClientCertificate(path.join(tmp, 'commander'), 'Commander');
    const commanderHash = new crypto.X509Certificate(commanderIdentity.cert).fingerprint
        .replace(/:/g, '')
        .toLowerCase();
    const commander = await connectUser('Commander', commanderIdentity);
    const stranger = await connectUser('Stranger');

    const handled = [];
    const bot = createMumbleCommandBot({
        config: getMumbleBotConfig(`mumble://WhatsAppBridge@${HOST}:${PORT}/Bridge`, ''),
        dataDir: path.join(tmp, 'bot'),
        release: 'e2e',
        commandPrefix: PREFIX,
        commanderIds: new Set([commanderHash.toUpperCase()]),
        extractCommand: (text) => {
            const trimmed = text.trim();
            if (trimmed.startsWith(PREFIX)) return trimmed.slice(PREFIX.length).trim();
            return BARE.has(trimmed.split(/\s+/)[0]) ? trimmed : null;
        },
        parseArgs: (text) => text.split(/\s+/).filter(Boolean),
        handleCommand: async (args) => {
            handled.push(args);
            return `ok ${args.join(' ')}\nline two`;
        },
        log,
    });
    bot.run();

    const botUser = () => admin.findUserByName('WhatsAppBridge-Bot');
    await waitFor('bot in channel from URI path', () => botUser() && botUser().channelId === bridgeChannel);
    assert.strictEqual(botUser().selfDeaf, true);
    assert.strictEqual(botUser().selfMute, true);
    assert.match(botUser().hash, /^[0-9a-f]{40}$/);
    assert.ok(fs.existsSync(path.join(tmp, 'bot', 'known-servers.json')), 'server certificate pinned');
    step('bot connects with certificate, self-muted/deafened, joins URI channel, pins server');

    assert.strictEqual(admin.findUserByName('Commander').hash, commanderHash);
    step('server reports the commander certificate hash');

    const bridge = await connectUser('WhatsAppBridge');
    bridge.moveToChannel(otherChannel);
    await waitFor('bot follows bridge user', () => botUser().channelId === otherChannel);
    step('bot follows the bridge user into another channel');

    commander.moveToChannel(otherChannel);
    stranger.moveToChannel(otherChannel);
    await waitFor('users moved', () =>
        admin.findUserByName('Commander').channelId === otherChannel &&
        admin.findUserByName('Stranger').channelId === otherChannel,
    );

    const reply = await expectReply(
        commander,
        () => commander.sendTextMessage({ channelIds: [otherChannel], text: '!wa status' }),
        /^ok status\nline two$/,
    );
    assert.deepStrictEqual(handled.at(-1), ['status']);
    step(`prefixed channel command answered privately (${JSON.stringify(reply)})`);

    await expectNoReply(commander, () =>
        commander.sendTextMessage({ channelIds: [otherChannel], text: 'status of the call?' }),
    );
    await expectNoReply(commander, () =>
        commander.sendTextMessage({ channelIds: [otherChannel], text: '!wake up' }),
    );
    step('bare words and other prefixes in channel chat are ignored');

    const botSession = botUser().session;
    await expectReply(
        commander,
        () => commander.sendTextMessage({ sessions: [botSession], text: 'status' }),
        /^ok status/,
    );
    await expectReply(
        commander,
        () => commander.sendTextMessage({ sessions: [botSession], text: '!wa call <x> & +49 1' }),
        /^ok call <x> & \+49 1/,
    );
    assert.deepStrictEqual(handled.at(-1), ['call', '<x>', '&', '+49', '1']);
    step('private bare and prefixed commands, HTML escaping round trip');

    const handledBefore = handled.length;
    await expectReply(
        stranger,
        () => stranger.sendTextMessage({ sessions: [botSession], text: '!wa status' }),
        /not allowed.*connect with a Mumble certificate/,
    );
    assert.strictEqual(handled.length, handledBefore);
    step('commander list rejects a user without the allowed certificate');

    // Kick the bot; it must reconnect, rejoin the bridge channel and keep working.
    admin.send(MessageType.UserRemove, encodeMessage([[1, botSession], [3, 'e2e kick']]));
    await waitFor('bot kicked', () => !botUser());
    await waitFor('bot reconnected', () => botUser() && botUser().channelId === otherChannel, 30000);
    await expectReply(
        commander,
        () => commander.sendTextMessage({ sessions: [botUser().session], text: '!wa help' }),
        /^ok help/,
    );
    step('bot reconnects after being kicked and answers again');

    // !switchChannel backend: the bot moves the bridge user (needs Move).
    const channelControl = createMumbleChannelControl({
        getClient: () => bot.client,
        bridgeUsername: 'WhatsAppBridge',
        botUsername: 'WhatsAppBridge-Bot',
    });
    const switchable = await channelControl.listSwitchableChannels();
    assert.deepStrictEqual(
        switchable.map((channel) => channel.name).sort(),
        ['Bridge', 'Root'],
    );
    step('switchable channels exclude the bridge user\'s current channel');

    const bridgeTarget = switchable.find((channel) => channel.name === 'Bridge');
    await assert.rejects(channelControl.moveToChannel(bridgeTarget), /Move permission/);
    assert.strictEqual(admin.findUserByName('WhatsAppBridge').channelId, otherChannel);
    step('moving the bridge user without the Move permission is refused clearly');

    // Grant Move (plus the usual defaults) to @all on the root channel.
    const PERMISSIONS = 0x2 | 0x4 | 0x8 | 0x20 | 0x100 | 0x200;
    admin.send(
        MessageType.ACL,
        encodeMessage([
            [1, 0],
            [2, true],
            [4, encodeMessage([[1, true], [2, true], [5, 'all'], [6, PERMISSIONS], [7, 0]])],
        ]),
    );
    let moveError = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await channelControl.moveToChannel(bridgeTarget);
            moveError = null;
            break;
        } catch (error) {
            moveError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    if (moveError) throw moveError;
    await waitFor('bridge user moved', () =>
        admin.findUserByName('WhatsAppBridge').channelId === bridgeChannel,
    );
    await waitFor('bot follows the moved bridge user', () => botUser().channelId === bridgeChannel);
    step('with Move permission the bridge user is moved and the bot follows');

    bot.stop();
    for (const client of [admin, commander, stranger, bridge]) client.close('done');
    console.log(`\n${pass} checks passed.\nBot log:\n  ${logs.join('\n  ')}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(`FAIL: ${error.stack || error.message}\nBot log:\n  ${logs.join('\n  ')}`);
        process.exit(1);
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
