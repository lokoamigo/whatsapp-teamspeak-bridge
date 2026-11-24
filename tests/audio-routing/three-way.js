'use strict';

// Disposable PulseAudio acceptance test. Use actual PCM streams with the
// process properties of each endpoint, initially opened on the wrong devices.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const { createAudioReconciler, startAudioRouter } = require('../../bot/audio/router');
const { runPactl } = require('../../bot/audio/pulse');
const { sleep } = require('../../bot/util');

const rate = 48000;
const endpoints = [
    { binary: 'ts3client_linux_amd64', microphone: 'wa_mic', frequency: 600 },
    { binary: 'bridge-mumble', microphone: 'mumble_mic', frequency: 1000 },
    { binary: 'chromium', microphone: 'ts_mic', frequency: 1600 },
];
const children = new Set();
const config = `${process.env.XDG_RUNTIME_DIR}/three-way.pa`;

function launch(command, args, stdio) {
    const child = spawn(command, args, { stdio });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
}

async function stop(child) {
    if (!children.has(child)) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
}

function startPulse() {
    return launch('pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1',
        '--log-level=error', `--file=${config}`], ['ignore', 'ignore', 'inherit']);
}

const list = async (type) => JSON.parse(await runPactl(['--format=json', 'list', type]));
async function waitForRoutes() {
    for (let i = 0; i < 100; i++) {
        const modules = await list('modules').catch(() => []);
        if (modules.filter((m) => m.name === 'module-loopback').length === 6) return;
        await sleep(100);
    }
    assert.fail('Timed out waiting for six loopbacks');
}

function pacatArgs(endpoint) {
    return ['--raw', '--format=s16le', '--channels=1', `--rate=${rate}`,
        '--latency-msec=40', `--property=application.process.binary=${endpoint.binary}`];
}

function play(endpoint) {
    const tone = Buffer.alloc(rate * 2 / 10);
    for (let i = 0; i < tone.length / 2; i++) {
        tone.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * endpoint.frequency * i / rate)), i * 2);
    }
    const child = launch('pacat', ['--playback', '--device=ts_mix', ...pacatArgs(endpoint)],
        ['pipe', 'ignore', 'inherit']);
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
    const write = () => {
        while (!child.stdin.destroyed) {
            if (!child.stdin.write(tone)) return;
        }
    };
    child.stdin.on('drain', write);
    write();
    return child;
}

function record(endpoint) {
    const child = launch('pacat', ['--record', '--device=mumble_out.monitor', ...pacatArgs(endpoint)],
        ['ignore', 'pipe', 'inherit']);
    const chunks = [];
    child.stdout.on('data', (data) => chunks.push(data));
    return { child, chunks };
}

// Measure a frequency over short windows so independent PulseAudio sink
// clocks and loopback resampling cannot cancel a tone across a long capture.
function amplitude(samples, frequency) {
    const n = 2400;
    let sum = 0;
    for (let window = 1; window <= 8; window++) {
        const start = samples.length / 2 - window * n;
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) {
            const value = samples.readInt16LE((start + i) * 2);
            const phase = 2 * Math.PI * frequency * i / rate;
            re += value * Math.cos(phase);
            im += value * Math.sin(phase);
        }
        sum += 2 * Math.hypot(re, im) / n;
    }
    return sum / 8;
}

async function checkMixes(active) {
    const captures = active.map(record);
    try {
        for (let i = 0; i < 100; i++) {
            if (captures.every(({ chunks }) => chunks.reduce((n, chunk) => n + chunk.length, 0) >= rate * 3)) break;
            await sleep(100);
        }
        for (const [i, { chunks }] of captures.entries()) {
            const samples = Buffer.concat(chunks);
            assert.ok(samples.length >= rate, 'at least half a second captured');
            for (const sender of endpoints) {
                const level = amplitude(samples, sender.frequency);
                const expected = sender !== active[i] && active.includes(sender);
                assert.ok(expected ? level > 800 : level < 100,
                    `${active[i].microphone} at ${sender.frequency} Hz: ${level.toFixed(1)} (expected ${expected ? 'audible' : 'absent'})`);
            }
        }
    } finally {
        await Promise.all(captures.map(({ child }) => stop(child)));
    }
}

async function main() {
    fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(config, execFileSync(process.execPath, [require.resolve('../../bot/audio/graph')]));
    let server = startPulse();
    await waitForRoutes();
    const reconciler = createAudioReconciler({ combined: true });
    const stopRouter = startAudioRouter({ reconciler, debounceMs: 75, reconnectMs: 100 });
    try {
        for (let pass = 0; pass < 2; pass++) {
            const voice = endpoints.slice(0, 2);
            const players = voice.map(play);
            await checkMixes(voice);
            const browser = play(endpoints[2]);
            await checkMixes(endpoints);
            await stop(browser);
            await checkMixes(voice);
            await Promise.all(players.map(stop));
            if (pass === 0) {
                await stop(server);
                server = startPulse();
                await waitForRoutes();
                const loop = (await list('modules')).find((m) => m.name === 'module-loopback');
                await runPactl(['unload-module', String(loop.index)]);
                await waitForRoutes();
                const mix = (await list('sinks')).find((s) => s.name === 'mumble_mix');
                await runPactl(['unload-module', String(mix.owner_module)]);
                await waitForRoutes();
                // After the subscription repair has settled, two further
                // snapshots must leave all six routes intact.
                await reconciler.reconcile();
                await reconciler.reconcile();
                await waitForRoutes();
            }
        }
        console.log('PASS: three simultaneous tones, own-tone exclusion, voice-only mix before/after browser audio, PulseAudio restart and repeat repair');
    } finally {
        stopRouter();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Promise.all([...children].map(stop));
});
