'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { createAudioGraph } = require('./graph');
const { runPactl } = require('./pulse');
const { COMBINED_VOICE, WHATSAPP_PULSE_SOURCE, WHATSAPP_PULSE_SOURCE_NUDGE } = require('../config');
const { sleep } = require('../util');

// Reconcile after subscription events, rather than continuously moving streams
// and toggling defaults. A full snapshot also repairs externally removed devices.
function createAudioReconciler({
    pactl = runPactl,
    combined = COMBINED_VOICE,
    pause = sleep,
    source = WHATSAPP_PULSE_SOURCE,
    nudgeSource = WHATSAPP_PULSE_SOURCE_NUDGE,
} = {}) {
    const graph = createAudioGraph(combined);
    const seenCaptures = new Set();
    const list = async (type) => JSON.parse(await pactl(['--format=json', 'list', type]));

    async function reconcile() {
        let sinks = await list('sinks');
        let sources = await list('sources');
        let created = false;
        for (const [devices, desired] of [[sinks, graph.sinks], [sources, graph.sources]]) {
            for (const [name, args] of desired) {
                if (devices.some((device) => device.name === name)) continue;
                await pactl(['load-module', ...args]);
                created = true;
            }
        }
        if (combined) {
            const loopbacks = (await list('modules')).filter((m) => m.name === 'module-loopback');
            for (const args of graph.routes) {
                const [, sourceArg, sinkArg] = args;
                const exists = loopbacks.some((module) => {
                    const parameters = module.argument.split(/\s+/);
                    return parameters.includes(sourceArg) && parameters.includes(sinkArg);
                });
                if (!exists) await pactl(['load-module', ...args]);
            }
        }
        if (created) {
            sinks = await list('sinks');
            sources = await list('sources');
        }
        if ((await pactl(['get-default-sink'])).trim() !== 'wa_out') {
            await pactl(['set-default-sink', 'wa_out']);
        }
        if ((await pactl(['get-default-source'])).trim() !== source) {
            await pactl(['set-default-source', source]);
        }

        const inputs = await list('sink-inputs');
        const outputs = await list('source-outputs');
        const liveCaptures = new Set(outputs.filter(isChromium).map((stream) => stream.index));
        for (const index of seenCaptures) {
            if (!liveCaptures.has(index)) seenCaptures.delete(index);
        }
        for (const [streams, devices, field, command] of [
            [inputs, sinks, 'sink', 'move-sink-input'],
            [outputs, sources, 'source', 'move-source-output'],
        ]) {
            for (const stream of streams) {
                const chromium = isChromium(stream);
                const binary = stream.properties?.['application.process.binary'];
                const mumble = binary === 'mumble' || binary === 'bridge-mumble';
                if (!chromium && !mumble && binary !== 'ts3client_linux_amd64') continue;
                let target = field === 'sink' ? 'ts_out' : 'wa_mic';
                if (chromium) target = field === 'sink' ? 'wa_out' : source;
                if (combined && mumble) target = field === 'sink' ? 'mumble_out' : 'mumble_mic';
                const device = devices.find((entry) => entry.name === target);
                if (!device) throw new Error(`PulseAudio device ${target} is unavailable.`);
                if (field === 'source' && chromium && !seenCaptures.has(stream.index)) {
                    // Keep the existing WhatsApp workaround, once per capture
                    // stream. Forget IDs when streams disappear or PA restarts.
                    await pactl(['set-default-source', nudgeSource]);
                    try {
                        await pause(200);
                    } finally {
                        await pactl(['set-default-source', source]);
                    }
                    seenCaptures.add(stream.index);
                }
                if (Number(stream[field]) !== device.index) {
                    // Streams can close between the snapshot and the move.
                    await pactl([command, String(stream.index), target]).catch(() => {});
                }
            }
        }
    }

    return { reconcile, reset: () => seenCaptures.clear() };
}

function isChromium(stream) {
    return stream.properties?.['application.process.binary'] === 'chromium';
}

function startAudioRouter({
    reconciler = createAudioReconciler(),
    subscribe = () => spawn('pactl', ['subscribe'], {
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
    }),
    debounceMs = 400,
    recoveryMs = 30000,
    reconnectMs = 3000,
    logError = (error) => console.error(`Audio router: ${error.message}`),
} = {}) {
    let stopped = false;
    let running = false;
    let dirty = false;
    let timer = null;
    let reconnect = null;
    let child = null;
    let lines = null;
    let lastErrorAt = -Infinity;

    function report(error) {
        if (Date.now() - lastErrorAt < 60000) return;
        lastErrorAt = Date.now();
        logError(error);
    }

    function schedule(delay = debounceMs) {
        if (stopped) return;
        dirty = true;
        if (running || timer) return;
        timer = setTimeout(async () => {
            timer = null;
            dirty = false;
            running = true;
            try {
                await reconciler.reconcile();
            } catch (error) {
                report(error);
            } finally {
                running = false;
                if (dirty) schedule();
            }
        }, delay);
        timer.unref();
    }

    function connect() {
        if (stopped) return;
        reconnect = null;
        reconciler.reset();
        child = subscribe();
        lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
            if (/^Event '(new|change|remove)' on (sink-input|source-output|sink|source|server) #/.test(line)) {
                schedule();
            }
        });
        child.on('error', report);
        child.once('close', (code) => {
            lines.close();
            child = null;
            if (stopped) return;
            if (code !== 0) report(new Error('PulseAudio subscription disconnected; retrying.'));
            reconnect = setTimeout(connect, reconnectMs);
            reconnect.unref();
        });
        schedule(0);
    }

    const recovery = setInterval(() => schedule(), recoveryMs);
    recovery.unref();
    connect();
    return () => {
        stopped = true;
        clearInterval(recovery);
        clearTimeout(timer);
        clearTimeout(reconnect);
        lines?.close();
        child?.kill();
    };
}

module.exports = { createAudioReconciler, startAudioRouter };
