'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    createTofuVerifier,
    MumbleClient,
    decodeMessage,
    encodeMessage,
    getRepeatedUint,
    mumbleHtmlToText,
    parseMumbleUri,
    textToMumbleHtml,
} = require('../bot/mumble/client');
const { getMumbleBotConfig } = require('../bot/mumble/commands');

test('Mumble queue stays bounded and reconnects on message or byte overflow', async () => {
    const client = new MumbleClient({});
    client.limited.level = 100;
    try {
        for (let i = 0; i < 128; i++) {
            assert.strictEqual(client.sendLimited(11, Buffer.from('x'), `key:${i}`), true);
        }
        assert.strictEqual(client.sendLimited(11, Buffer.from('replacement'), 'key:0'), true);
        assert.strictEqual(client.limited.queue.length, 128);
        let closed = 0;
        client.on('closed', () => { closed += 1; });
        assert.strictEqual(client.sendLimited(11, Buffer.from('overflow')), false);
        assert.match(await client.closed, /queue limit exceeded/);
        assert.strictEqual(client.limited.queue.length, 0);
        assert.strictEqual(client.sendLimited(11, Buffer.from('after closing')), false);
        client.close('again');
        assert.strictEqual(closed, 1);
    } finally {
        client.close();
    }
    const large = new MumbleClient({});
    assert.strictEqual(large.sendLimited(11, Buffer.alloc(256 * 1024 + 1)), false);
    assert.match(await large.closed, /queue limit exceeded/);
});

test('protobuf round trip keeps varints, strings and repeated fields', () => {
    const buffer = encodeMessage([
        [1, 300],
        [2, [7, 8]],
        [5, 'héllo'],
        [6, true],
        [7, (1n << 48n) | (4n << 32n)],
        [8, undefined],
    ]);
    const fields = decodeMessage(buffer);
    assert.strictEqual(fields.get(1)[0], 300n);
    assert.deepStrictEqual(getRepeatedUint(fields, 2), [7, 8]);
    assert.strictEqual(fields.get(5)[0].toString('utf8'), 'héllo');
    assert.strictEqual(fields.get(6)[0], 1n);
    assert.strictEqual(fields.get(7)[0], (1n << 48n) | (4n << 32n));
    assert.strictEqual(fields.has(8), false);
});

test('packed repeated uint32 fields are decoded', () => {
    // field 2, wire type 2, length 3, varints 1, 2, 150 (0x96 0x01)
    const packed = Buffer.from([0x12, 0x04, 0x01, 0x02, 0x96, 0x01]);
    assert.deepStrictEqual(getRepeatedUint(decodeMessage(packed), 2), [1, 2, 150]);
});

test('Mumble HTML is reduced to typed text and replies are escaped', () => {
    assert.strictEqual(mumbleHtmlToText('<p>!wa call &lt;x&gt; &amp; +49&#32;1</p>'), '!wa call <x> & +49 1');
    assert.strictEqual(mumbleHtmlToText('a<br/>b&nbsp;c'), 'a\nb c');
    assert.strictEqual(textToMumbleHtml('a <b>\nc & d'), 'a &lt;b&gt;<br/>c &amp; d');
});

test('Mumble URIs are parsed and decoded', () => {
    assert.deepStrictEqual(
        parseMumbleUri('mumble://Whats%20App:p%40ss@mumble.example.org:1234/Parent/Br%C3%BCcke?version=1.2.0'),
        {
            host: 'mumble.example.org',
            port: 1234,
            username: 'Whats App',
            password: 'p@ss',
            channelPath: ['Parent', 'Brücke'],
        },
    );
    assert.strictEqual(parseMumbleUri('mumble://example.org').port, 64738);
    assert.strictEqual(parseMumbleUri(''), null);
    assert.throws(() => parseMumbleUri('https://example.org'), /mumble:\/\//);
});

test('bot config derives its name and server from MUMBLE_URI', () => {
    const fromBridge = getMumbleBotConfig('mumble://Bridge:pw@host/Room', '');
    assert.strictEqual(fromBridge.username, 'Bridge-Bot');
    assert.strictEqual(fromBridge.password, 'pw');
    assert.strictEqual(fromBridge.bridgeUsername, 'Bridge');
    assert.deepStrictEqual(fromBridge.channelPath, ['Room']);

    const own = getMumbleBotConfig('mumble://Bridge@host/Room', 'mumble://Cmd@other:99/Lobby');
    assert.strictEqual(own.username, 'Cmd');
    assert.strictEqual(own.host, 'other');
    assert.deepStrictEqual(own.channelPath, ['Lobby']);
    assert.strictEqual(own.bridgeUsername, 'Bridge');

    assert.strictEqual(getMumbleBotConfig('mumble://host', '').username, 'WhatsAppBridge-Bot');
    assert.strictEqual(getMumbleBotConfig('', ''), null);
});

test('TOFU verifier pins the first certificate and refuses a changed one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mumble-tofu-'));
    const pinFile = path.join(dir, 'known-servers.json');
    const verify = createTofuVerifier(pinFile);
    const first = { raw: Buffer.from('first') };
    try {
        assert.strictEqual(verify('h', 1, first, false).pinned, true);
        assert.strictEqual(verify('h', 1, first, false).pinned, false);
        assert.throws(() => verify('h', 1, { raw: Buffer.from('second') }, false), /changed/);
        assert.strictEqual(verify('h', 1, { raw: Buffer.from('second') }, true).trusted, true);
        assert.strictEqual(verify('h', 2, { raw: Buffer.from('second') }, false).pinned, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
