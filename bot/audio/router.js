'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { runPactl } = require('./pulse');
const { WHATSAPP_PULSE_SOURCE, WHATSAPP_PULSE_SOURCE_NUDGE } = require('../config');
const { sleep } = require('../util');

// Reconcile after subscription events, rather than continuously moving streams
// and toggling defaults. A full snapshot also repairs externally removed devices.
function createAudioReconciler({
    pactl = runPactl,
    pause = sleep,
    source = WHATSAPP_PULSE_SOURCE,
    nudgeSource = WHATSAPP_PULSE_SOURCE_NUDGE,
} = {}) {
    const seenCaptures = new Set();
    const list = async (type) => JSON.parse(await pactl(['--format=json', 'list', type]));

    async function reconcile() {
        let sinks = await list('sinks');
        let sources = await list('sources');
        let created = false;
        for (const [name, description] of [
            ['ts_out', 'TeamSpeak_to_WhatsApp'],
            ['wa_out', 'WhatsApp_to_TeamSpeak'],
        ]) {
            if (sinks.some((sink) => sink.name === name)) continue;
            await pactl(['load-module', 'module-null-sink', `sink_name=${name}`,
                'rate=48000', 'channels=2', 'channel_map=front-left,front-right',
                `sink_properties=device.description=${description}`]);
            created = true;
        }
        for (const [name, master, description] of [
            ['ts_mic', 'ts_out.monitor', 'TeamSpeak_to_WhatsApp_Microphone'],
            ['wa_mic', 'wa_out.monitor', 'WhatsApp_to_TeamSpeak_Microphone'],
        ]) {
            if (sources.some((device) => device.name === name)) continue;
            await pactl(['load-module', 'module-remap-source', `source_name=${name}`,
                `master=${master}`, 'rate=48000', 'channels=2',
                'channel_map=front-left,front-right',
                'master_channel_map=front-left,front-right',
                `source_properties=device.description=${description}`]);
            created = true;
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
                const voice = ['mumble', 'bridge-mumble', 'ts3client_linux_amd64'].includes(
                    stream.properties?.['application.process.binary'],
                );
                if (!chromium && !voice) continue;
                const target = field === 'sink'
                    ? (chromium ? 'wa_out' : 'ts_out')
                    : (chromium ? source : 'wa_mic');
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
