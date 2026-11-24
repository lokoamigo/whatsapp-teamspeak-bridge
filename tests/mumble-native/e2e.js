'use strict';

// Real Mumble + independent PulseAudio graphs. Synthetic PCM traverses capture,
// Opus, TCP/UDP, server forwarding, per-user decoding/mixing and playback.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { MumbleClient, MessageType, encodeMessage, ensureClientCertificate, mumbleHtmlToText } = require('../../bot/mumble/client');
const { NativeMumbleClient, createNativeMumbleControl } = require('../../bot/mumble/native');

const host = process.env.MUMBLE_TEST_HOST;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mumble-e2e-'));
const children = [];
const controls = [];
const logs = [];
const sockets = new Set();
let proxy;
let proxyAccept = true;
let admin;
let commander;
let pass = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (description) => { console.log(`PASS: ${description}`); pass += 1; };

async function until(description, check, ms = 20000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { const result = await check(); if (result) return result; } catch (error) { last = error; }
        await pause(50);
    }
    throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
function launch(command, args, env = {}, stdio = ['ignore', 'ignore', 'pipe']) {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio });
    children.push(child);
    child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        // The fixture is entirely synthetic; retain only a bounded failure log.
        if (!text.includes('Failed to connect to system bus')) {
            logs.push(text.trim());
            if (logs.length > 100) logs.shift();
        }
    });
    return child;
}
async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
}
function pulse(fixture) {
    fixture.pulse = launch('pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1', '--log-level=error', `--file=${fixture.config}`], fixture.env);
}
function helper(fixture, uri) {
    fixture.helper = launch('/work/native/mumble/target/release/bridge-mumble', [], {
        ...fixture.env, MUMBLE_URI: uri, MUMBLE_DATA_DIR: fixture.data, MUMBLE_NATIVE_SOCKET: fixture.socket,
    });
}
async function audioFixture(name, uri, handler) {
    const directory = path.join(root, name);
    const runtime = path.join(directory, 'runtime');
    fs.mkdirSync(path.join(runtime, 'pulse'), { recursive: true, mode: 0o700 });
    const fixture = { directory, data: path.join(directory, 'data'), socket: path.join(runtime, 'control.sock'),
        env: { XDG_RUNTIME_DIR: runtime, PULSE_SERVER: `unix:${runtime}/pulse/native` }, config: path.join(directory, 'bridge.pa') };
    const combined = name === 'bridge' && process.env.BRIDGE_TEST_THREE_WAY === '1';
    if (combined) fixture.env.BRIDGE_VOICE_BACKEND = 'teamspeak-mumble';
    const graph = combined
        ? execFileSync(process.execPath, [require.resolve('../../bot/audio/graph')], { encoding: 'utf8' })
        : fs.readFileSync('/work/rootfs/etc/pulse/bridge.pa', 'utf8');
    fs.writeFileSync(fixture.config, graph.replace('/tmp/runtime-bridge/pulse/native', `${runtime}/pulse/native`));
    pulse(fixture);
    if (name === 'bridge') {
        const identity = await ensureClientCertificate(path.join(directory, 'original'), 'OriginalVoiceIdentity');
        const bundle = execFileSync('openssl', ['pkcs12', '-export', '-in', path.join(directory, 'original/cert.pem'),
            '-inkey', path.join(directory, 'original/key.pem'), '-passout', 'pass:']);
        fixture.hash = new crypto.X509Certificate(identity.cert).fingerprint.replace(/:/g, '').toLowerCase();
        const gui = path.join(fixture.data, '.config/Mumble/Mumble.conf');
        fs.mkdirSync(path.dirname(gui), { recursive: true });
        fs.writeFileSync(gui, `[net]\ncertificate=@ByteArray(${[...bundle].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')})\n`);
        fixture.gui = gui;
        fixture.guiBefore = fs.readFileSync(gui);
    }
    helper(fixture, uri);
    const options = { socketPath: fixture.socket, log: { log() {}, error: (line) => logs.push(line) }, retryMs: 100 };
    fixture.control = handler ? createNativeMumbleControl({ ...options, ...handler }) : new NativeMumbleClient(options);
    fixture.running = fixture.control.run();
    controls.push(fixture);
    await until(`${name} connected`, () => fixture.control.connected);
    await until(`${name} PulseAudio ready`, async () => {
        const status = await fixture.control.request('status');
        return status.captureReady && status.playbackReady;
    });
    return fixture;
}
function record(fixture, device = 'ts_mic') {
    const samples = [];
    const child = launch('pacat', ['--record', '--raw', '--rate=48000', '--channels=1', '--format=s16le', `--device=${device}`], fixture.env, ['ignore', 'pipe', 'pipe']);
    let bytes = 0;
    child.stdout.on('data', (data) => {
        samples.push(data); bytes += data.length;
        while (bytes > 48000 * 2 * 3 && samples.length > 1) bytes -= samples.shift().length;
    });
    return { child, clear: () => { samples.length = 0; bytes = 0; }, pcm: () => Buffer.concat(samples) };
}
function tone(fixture, frequency, seconds = 3) {
    const pcm = Buffer.alloc(48000 * 2 * seconds);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * frequency / 48000) * 3500), i * 2);
    const child = launch('pacat', ['--playback', '--raw', '--rate=48000', '--channels=1', '--format=s16le', '--device=wa_out'], fixture.env, ['pipe', 'ignore', 'pipe']);
    child.stdin.on('error', () => {});
    child.stdin.end(pcm);
    return child;
}
function power(pcm, frequency, window = 48000) {
    const samples = Math.min(Math.floor(pcm.length / 2), window);
    if (samples < Math.min(window, 4800)) return 0;
    const start = pcm.length - samples * 2;
    let real = 0; let imaginary = 0;
    for (let i = 0; i < samples; i++) {
        const value = pcm.readInt16LE(start + i * 2);
        const angle = i * 2 * Math.PI * frequency / 48000;
        real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
    }
    return Math.hypot(real, imaginary) / samples;
}
async function expectReply(send, expression) {
    const before = commander.replies.length;
    send();
    const reply = await until(`reply ${expression}`, () => commander.replies.slice(before).find((text) => expression.test(text)));
    assert.match(reply, expression);
}
function rss(pid) {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    return { rssKiB: Number(text.match(/^Rss:\s+(\d+)/m)[1]), pssKiB: Number(text.match(/^Pss:\s+(\d+)/m)[1]) };
}

async function main() {
    admin = new MumbleClient({ host, port: 64738, username: 'SuperUser', password: process.env.MUMBLE_TEST_SUPERUSER_PASSWORD,
        verifyServer: () => ({ trusted: true }) });
    admin.replies = [];
    admin.on('textMessage', (event) => admin.replies.push(mumbleHtmlToText(event.message)));
    await admin.connect();
    for (const name of ['Bridge', 'Other']) admin.send(MessageType.ChannelState, encodeMessage([[2, 0], [3, name]]));
    const channel = await until('Bridge channel', () => admin.findChannelByPath(['Bridge']));
    const other = await until('Other channel', () => admin.findChannelByPath(['Other']));
    admin.moveToChannel(channel);
    await until('admin joined', () => admin.self.channelId === channel);
    const commanderIdentity = await ensureClientCertificate(path.join(root, 'commander'), 'Commander');
    const commanderHash = new crypto.X509Certificate(commanderIdentity.cert).fingerprint.replace(/:/g, '').toLowerCase();
    commander = new MumbleClient({ host, port: 64738, username: 'Commander', ...commanderIdentity,
        verifyServer: () => ({ trusted: true }) });
    commander.replies = [];
    commander.on('textMessage', (event) => commander.replies.push(mumbleHtmlToText(event.message)));
    await commander.connect();
    commander.moveToChannel(channel);
    await until('commander joined', () => commander.self.channelId === channel);
    proxy = net.createServer((local) => {
        if (!proxyAccept) { local.destroy(); return; }
        const remote = net.createConnection(64738, host);
        for (const socket of [local, remote]) {
            sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
        }
        local.on('close', () => remote.destroy()); remote.on('close', () => local.destroy());
        local.pipe(remote); remote.pipe(local);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const uri = `mumble://WhatsAppBridge@localhost:${proxy.address().port}/Bridge`;
    const handled = [];
    const bridge = await audioFixture('bridge', uri, {
        commandPrefix: '!wa', commanderIds: new Set([commanderHash.toUpperCase()]),
        extractCommand: (text) => text.startsWith('!wa ') ? text.slice(4) : text,
        parseArgs: (text) => text.split(' '),
        handleCommand: async (args) => { handled.push(args); return 'ok <native> & audio'; },
    });
    const peerB = await audioFixture('peer-b', `mumble://PeerB@${host}:64738/Bridge`);
    const peerC = await audioFixture('peer-c', `mumble://PeerC@${host}:64738/Bridge`);
    const user = () => [...admin.users.values()].find((u) => u.name === 'WhatsAppBridge');
    await until('single native account', () => user());
    assert.strictEqual(admin.users.size, 5, 'three audio clients, admin and commander, without another bot account');
    assert.strictEqual(user().hash, bridge.hash, 'GUI certificate registration survives import');
    assert.deepStrictEqual(fs.readFileSync(bridge.gui), bridge.guiBefore);
    step('one audio/chat account, GUI identity imported, rollback profile unchanged');

    await expectReply(() => commander.sendTextMessage({ channelIds: [channel], text: '!wa status' }), /ok <native> & audio/);
    await expectReply(() => commander.sendTextMessage({ sessions: [user().session], text: 'status' }), /ok <native> & audio/);
    assert.strictEqual(handled.length, 2);
    await bridge.control.sendChannelMessage('native announcement');
    await until('announcement', () => admin.replies.includes('native announcement'));
    step('channel/private commands, escaped replies and announcements share the audio account');
    const beforeRefusal = admin.replies.length;
    admin.sendTextMessage({ sessions: [user().session], text: '!wa hangup' });
    await until('unauthorized command refusal', () => admin.replies.slice(beforeRefusal).some((text) => text.includes('not allowed')));
    assert.strictEqual(handled.length, 2);
    step('command authorization uses the server-reported sender certificate');
    const health = execFileSync('/work/native/mumble/target/release/bridge-mumble', ['--status'], {
        env: { ...process.env, MUMBLE_NATIVE_SOCKET: bridge.socket }, encoding: 'utf8',
    });
    assert.strictEqual(JSON.parse(health).connected, true);
    step('independent health probes work while Node owns command control');

    await pause(500);
    const idle = await bridge.control.request('status');
    assert.strictEqual(idle.transmitting, false);
    assert.strictEqual(idle.captured, 0, 'digital silence must not be encoded or sent');
    step('idle capture does not transmit silence');

    await until('UDP enabled for direct peer', async () => (await peerB.control.request('status')).transport === 'udp');
    assert.strictEqual((await bridge.control.request('status')).transport, 'tcp');
    step('encrypted UDP and TCP-only fallback are both active');
    const recordA = record(bridge);
    const recordB = record(peerB);
    await pause(300);
    const sendingA = tone(bridge, 600, 4);
    await until('bridge to Mumble PCM', () => power(recordB.pcm(), 600) > 300);
    assert.ok(power(recordA.pcm(), 600) < 150, 'own audio must not feed back');
    await stop(sendingA);
    await until('voice activity releases after sound stops', async () => !(await bridge.control.request('status')).transmitting);
    const afterSound = (await bridge.control.request('status')).captured;
    await pause(500);
    assert.strictEqual((await bridge.control.request('status')).captured, afterSound,
        'capture count must stay still after the release period');
    recordA.clear();
    const sendingB = tone(peerB, 440, 5);
    const sendingC = tone(peerC, 880, 5);
    await until('simultaneous speakers mixed into WhatsApp PCM', () => power(recordA.pcm(), 440) > 250 && power(recordA.pcm(), 880) > 250);
    await stop(sendingB); await stop(sendingC);
    step('bidirectional PCM survives Opus/server transport; overlapping speakers mix without a loop');

    if (bridge.env.BRIDGE_VOICE_BACKEND === 'teamspeak-mumble') {
        const teamSpeak = record(bridge, 'wa_mic');
        const continuous = tone(peerB, 600, 6);
        try {
            await until('continuous Mumble audio in both downstream microphones', () =>
                [recordA, teamSpeak].every((capture) => {
                    const pcm = capture.pcm();
                    const window = 960 * 2;
                    const windows = 50;
                    if (pcm.length < window * windows) return false;
                    return Array.from({ length: windows }, (_, i) => {
                        const end = pcm.length - i * window;
                        return power(pcm.subarray(end - window, end), 600, 960);
                    }).every((level) => level > 200);
                }));
        } finally {
            await stop(continuous);
            await stop(teamSpeak.child);
        }
        step('Mumble playback is continuous in both TeamSpeak and WhatsApp microphone mixes');

        // The operator moves the bridge while audio is live. Peer B stays
        // behind and peer C follows the operator into the destination room.
        const ongoing = tone(bridge, 600, 12);
        const recordC = record(peerC);
        await until('old room hears ongoing audio', () => power(recordB.pcm(), 600) > 300);
        admin.moveUserToChannel(user().session, other);
        admin.moveUserToChannel(admin.session, other);
        const peerSession = [...admin.users.values()].find((u) => u.name === 'PeerC').session;
        admin.moveUserToChannel(peerSession, other);
        await until('operator moved accounts', () => user().channelId === other && admin.self.channelId === other);
        await until('audio arrives in destination', () => power(recordC.pcm(), 600) > 300);
        await bridge.control.sendChannelMessage('announcement after move');
        await until('destination receives announcement', () => admin.replies.includes('announcement after move'));
        await pause(1500);
        assert.ok(power(recordB.pcm(), 600) < 150, 'old room no longer receives audio');
        assert.ok(power(recordC.pcm(), 600) > 300, 'bridge still transmitting in destination');
        assert.ok(!commander.replies.includes('announcement after move'), 'old room receives no announcement');
        await stop(ongoing);
        await stop(recordC.child);
        admin.moveUserToChannel(user().session, channel);
        await until('operator returned bridge', () => user().channelId === channel);
        step('server-side move redirects live audio and announcements away from the old room');
    }

    await bridge.control.moveToChannel({ id: other });
    await until('native self-move', () => user().channelId === other);
    await bridge.control.moveToChannel({ id: channel });
    step('self channel switching confirms server state without a second-user Move ACL');
    admin.send(MessageType.ACL, encodeMessage([[1, other], [2, true],
        [4, encodeMessage([[1, true], [2, true], [5, 'all'], [6, 0], [7, 0x4]])]]));
    await pause(300);
    await assert.rejects(bridge.control.moveToChannel({ id: other }), /Enter\/Traverse/);
    assert.strictEqual(user().channelId, channel);
    step('denied channel entry returns a confirmed error without changing channels');

    proxyAccept = false;
    for (const socket of sockets) socket.destroy();
    await until('network outage noticed', () => !bridge.control.connected);
    await pause(500); proxyAccept = true;
    await until('network reconnect', () => bridge.control.connected);
    await until('same certificate after reconnect', () => user()?.hash === bridge.hash);
    step('network outage reconnects with the same identity');

    await stop(bridge.pulse);
    await pause(250);
    pulse(bridge);
    await until('audio streams recover after PulseAudio restart', async () => {
        const state = await bridge.control.request('status');
        return state.captureReady && state.playbackReady;
    });
    await stop(recordA.child);
    const recoveredRecord = record(bridge);
    const recoveredTone = tone(peerB, 440, 5);
    await until('audio after PulseAudio restart', () => power(recoveredRecord.pcm(), 440) > 250);
    await stop(recoveredTone);
    step('PulseAudio restart reopens streams and restores real audio');

    const identityBefore = fs.readFileSync(path.join(bridge.data, 'native/identity.pem'));
    await stop(bridge.helper);
    helper(bridge, uri);
    await until('helper reconnect', () => bridge.control.connected);
    await until('helper identity unchanged', () => user()?.hash === bridge.hash);
    assert.deepStrictEqual(fs.readFileSync(path.join(bridge.data, 'native/identity.pem')), identityBefore);
    step('helper restart preserves identity and Node reconnects');

    const pinFile = path.join(bridge.data, 'native/known-servers.json');
    const goodPins = fs.readFileSync(pinFile);
    await stop(bridge.helper);
    const wrongPins = JSON.parse(goodPins);
    for (const key of Object.keys(wrongPins)) wrongPins[key] = '00'.repeat(32);
    fs.writeFileSync(pinFile, JSON.stringify(wrongPins));
    helper(bridge, uri);
    await pause(1800);
    assert.strictEqual(bridge.control.connected, false, 'changed server certificate must be refused');
    assert.ok(logs.some((line) => line.includes('server certificate changed')));
    await stop(bridge.helper);
    fs.writeFileSync(pinFile, goodPins);
    helper(bridge, uri);
    await until('restored trusted helper', () => bridge.control.connected);
    step('changed server fingerprints are refused');

    const before = rss(bridge.helper.pid);
    for (let i = 0; i < 100; i++) await bridge.control.listSwitchableChannels();
    await pause(1000);
    const after = rss(bridge.helper.pid);
    assert.ok(after.pssKiB < 64 * 1024, `native footprint unexpectedly high: ${after.pssKiB} KiB PSS`);
    assert.ok(after.pssKiB - before.pssKiB < 4096, 'repeated operations must not retain a growing history');
    step(`native process memory: ${after.rssKiB} KiB RSS / ${after.pssKiB} KiB PSS`);
    console.log(`${pass} native Mumble checks passed.`);
}

main().catch((error) => {
    console.error(error);
    console.error('Bounded fixture log:', logs.slice(-25).join('\n'));
    process.exitCode = 1;
}).finally(async () => {
    for (const fixture of controls) fixture.control.stop();
    for (const fixture of controls) await fixture.running;
    admin?.close();
    commander?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    for (const child of children.reverse()) await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
});
