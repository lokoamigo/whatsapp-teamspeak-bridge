'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { once } = require('events');
const { NativeMumbleClient, createNativeMumbleControl } = require('../bot/mumble/native');

async function until(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), 'native adapter made progress');
}

async function fixture(t, options = {}, respond = null) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mumble-test-'));
    const socketPath = path.join(directory, 'control.sock');
    const received = [];
    let peer;
    const server = net.createServer((socket) => {
        peer = socket;
        socket.on('error', () => {});
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const request = JSON.parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                received.push(request);
                if (respond) respond(socket, request);
                else socket.write(`${JSON.stringify({ id: request.id, result: ['status', 'attach'].includes(request.op) ? { connected: true } : null })}\n`);
            }
        });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const client = options.control ? createNativeMumbleControl({ ...options, socketPath })
        : new NativeMumbleClient({ socketPath, log: { error() {} }, retryMs: 5, ...options });
    const attached = once(client, 'attached');
    const running = client.run();
    t.after(async () => {
        client.stop();
        await running;
        peer?.destroy();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await attached;
    return { client, received, get peer() { return peer; } };
}

test('native account shares authorization, private commands, replies and channel control', async (t) => {
    const handled = [];
    const f = await fixture(t, {
        control: true,
        commandPrefix: '!wa', commanderIds: new Set(['CERTIFICATE']),
        extractCommand: (text) => text.startsWith('!wa ') ? text.slice(4) : text,
        parseArgs: (text) => text.split(' '),
        handleCommand: async (args) => { handled.push(args); return 'ok <x> & y'; },
        log: { log() {}, error() {} },
    });
    const event = (message, isPrivate = false, hash = 'certificate') => JSON.stringify({
        event: 'text', message, private: isPrivate, actor: 7, user: { name: 'Commander', hash },
    }) + '\n';
    const message = event('!wa status');
    f.peer.write(message.slice(0, 9));
    f.peer.write(message.slice(9));
    await until(() => f.received.some((r) => r.op === 'send_text'));
    assert.deepStrictEqual(handled, [['status']]);
    assert.strictEqual(f.received.find((r) => r.op === 'send_text').text, 'ok &lt;x&gt; &amp; y');
    f.peer.write(event('ordinary conversation') + event('!wake up') + event('status', true));
    await until(() => handled.length === 2);
    assert.deepStrictEqual(handled[1], ['status']);
    f.peer.write(event('!wa hangup', false, 'stranger'));
    await until(() => f.received.some((r) => r.op === 'send_text' && r.text.includes('not allowed')));
    assert.strictEqual(handled.length, 2);
    await f.client.listSwitchableChannels();
    await f.client.moveToChannel({ id: '12' });
    await f.client.sendChannelMessage('hello <everyone>');
    assert.ok(f.received.some((r) => r.op === 'channels'));
    assert.ok(f.received.some((r) => r.op === 'move' && r.channel === 12));
    assert.ok(f.received.some((r) => r.op === 'send_channel' && r.text === 'hello &lt;everyone&gt;'));
});

test('native RPC bounds pending work and rejects it promptly on disconnect', async (t) => {
    const f = await fixture(t, { timeoutMs: 10000 }, (socket, request) => {
        if (['status', 'attach'].includes(request.op)) socket.write(JSON.stringify({ id: request.id, result: { connected: true } }) + '\n');
    });
    const pending = Array.from({ length: 32 }, () => f.client.request('channels').catch((error) => error));
    await assert.rejects(f.client.request('channels'), /queue is full/);
    assert.strictEqual(f.client.pending.size, 32);
    f.client.stop();
    const errors = await Promise.all(pending);
    assert.ok(errors.every((error) => /disconnected/.test(error.message)));
    assert.strictEqual(f.client.pending.size, 0);
});

test('status snapshots do not override newer connection events', async (t) => {
    const f = await fixture(t, {}, (socket, request) => {
        if (['status', 'attach'].includes(request.op)) socket.write(
            JSON.stringify({ id: request.id, result: { connected: false } }) + '\n' +
            JSON.stringify({ event: 'connected' }) + '\n',
        );
    });
    assert.strictEqual(f.client.connected, true);
    f.peer.write(JSON.stringify({ event: 'disconnected' }) + '\n');
    await until(() => !f.client.connected);
    await assert.rejects(f.client.listSwitchableChannels(), /not connected/);
});

test('oversized IPC input disconnects without retaining pending requests', async (t) => {
    const f = await fixture(t, { timeoutMs: 10000 }, (socket, request) => {
        if (['status', 'attach'].includes(request.op)) socket.write(JSON.stringify({ id: request.id, result: { connected: true } }) + '\n');
    });
    const pending = f.client.request('channels').catch((error) => error);
    f.peer.write('x'.repeat(65537));
    assert.match((await pending).message, /disconnected/);
    assert.strictEqual(f.client.pending.size, 0);
});
