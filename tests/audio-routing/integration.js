'use strict';

// Runs inside a disposable bridge image, with no persistent profile attached.
const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const { once } = require('events');
const { createAudioReconciler, startAudioRouter } = require('../../bot/audio/router');
const { runPactl } = require('../../bot/audio/pulse');
const { sleep } = require('../../bot/util');

const children = [];
const commands = [];
let stopRouter;
const list = async (type) => JSON.parse(await runPactl(['--format=json', 'list', type]));

async function until(check) {
    let lastError;
    for (let i = 0; i < 150; i++) {
        try { if (await check()) return; } catch (error) { lastError = error; }
        await sleep(100);
    }
    throw new Error(`Audio integration condition timed out: ${lastError?.message || check}`);
}

function launch(command, args, stdio = ['ignore', 'ignore', 'inherit']) {
    const child = spawn(command, args, { stdio });
    children.push(child);
    return child;
}

async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
}

function pulse() {
    return launch('pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1',
        '--log-level=error', '--file=/etc/pulse/bridge.pa']);
}

async function main() {
    fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const server = pulse();
    await until(async () => (await list('sources')).some((source) => source.name === 'wa_mic'));
    const reconciler = createAudioReconciler({
        pactl: async (args) => { commands.push(args); return runPactl(args); },
    });
    stopRouter = startAudioRouter({ reconciler, debounceMs: 100, reconnectMs: 100 });
    await until(() => commands.length >= 6);
    await sleep(400);
    const idleCommands = commands.length;
    await sleep(1100);
    assert.strictEqual(commands.length, idleCommands, 'idle router does not poll every second');

    const zero = fs.openSync('/dev/zero', 'r');
    let playback;
    try {
        playback = launch('pacat', ['--playback', '--raw', '--device=wa_out',
            '--property=application.process.binary=mumble', '--stream-name=router-playback'],
        [zero, 'ignore', 'inherit']);
    } finally {
        fs.closeSync(zero);
    }
    const capture = launch('pacat', ['--record', '--raw', '--device=wa_mic',
        '--property=application.process.binary=chromium', '--stream-name=router-capture']);
    const findStream = (type, name) => list(type).then((streams) =>
        streams.find((stream) => stream.properties['media.name'] === name),
    );
    await until(async () => {
        const sink = (await list('sinks')).find((device) => device.name === 'ts_out');
        const input = await findStream('sink-inputs', 'router-playback');
        return input?.sink === sink.index;
    });
    await until(async () => {
        const source = (await list('sources')).find((device) => device.name === 'ts_mic');
        const output = await findStream('source-outputs', 'router-capture');
        return output?.source === source.index;
    });
    await sleep(500);
    assert.ok(commands.some((args) => args[0] === 'set-default-source' && args[1] === 'wa_mic'));
    assert.strictEqual((await runPactl(['get-default-source'])).trim(), 'ts_mic');
    const moves = () => commands.filter((args) => args[0].startsWith('move-')).length;
    const firstMoves = moves();
    await sleep(700);
    assert.strictEqual(moves(), firstMoves, 'routing does not create a feedback loop');
    await stop(playback);
    await stop(capture);

    const source = (await list('sources')).find((device) => device.name === 'ts_mic');
    await runPactl(['unload-module', String(source.owner_module)]);
    await until(async () => (await list('sources')).some((device) => device.name === 'ts_mic'));

    await stop(server);
    pulse();
    await until(async () => (await list('sources')).some((device) => device.name === 'ts_mic'));
    await runPactl(['set-default-sink', 'ts_out']);
    await until(async () => (await runPactl(['get-default-sink'])).trim() === 'wa_out');
    console.log('PASS: idle, playback/capture routes, microphone nudge, device repair, PulseAudio restart');
    console.log(`Idle snapshot: ${idleCommands} pactl commands; no further commands during 1.1 seconds idle.`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    stopRouter?.();
    for (const child of children.reverse()) await stop(child);
});
