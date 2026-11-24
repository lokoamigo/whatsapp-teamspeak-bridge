'use strict';

// PulseAudio starts the complete three-way mix before the clients open their
// streams. The router uses the same module arguments to repair it at runtime.
function createAudioGraph(combined) {
    const sinks = new Map();
    const sources = new Map();
    const routes = [];
    const stereo = ['rate=48000', 'channels=2', 'channel_map=front-left,front-right'];

    function sink(name, description) {
        sinks.set(name, ['module-null-sink', `sink_name=${name}`, ...stereo,
            `sink_properties=device.description=${description}`]);
    }

    function microphone(name, master, description) {
        sources.set(name, ['module-remap-source', `source_name=${name}`,
            `master=${master}.monitor`, ...stereo, 'master_channel_map=front-left,front-right',
            `source_properties=device.description=${description}`]);
    }

    sink('ts_out', 'TeamSpeak_to_WhatsApp');
    sink('wa_out', 'WhatsApp_to_TeamSpeak');
    if (combined) {
        sink('mumble_out', 'Mumble_Playback');
        const endpoints = ['ts', 'wa', 'mumble'];
        for (const receiver of endpoints) {
            sink(`${receiver}_mix`, `${receiver}_microphone_mix`);
            for (const sender of endpoints) {
                if (sender === receiver) continue;
                routes.push(['module-loopback', `source=${sender}_out.monitor`, `sink=${receiver}_mix`,
                    'source_dont_move=true', 'sink_dont_move=true', 'latency_msec=30']);
            }
        }
        microphone('mumble_mic', 'mumble_mix', 'Mumble_Microphone');
    }
    // These two public names are retained for existing client profiles.
    microphone('ts_mic', combined ? 'wa_mix' : 'ts_out', 'TeamSpeak_to_WhatsApp_Microphone');
    microphone('wa_mic', combined ? 'ts_mix' : 'wa_out', 'WhatsApp_to_TeamSpeak_Microphone');
    return { sinks, sources, routes };
}

if (require.main === module) {
    const graph = createAudioGraph(true);
    console.log('.fail');
    console.log('load-module module-native-protocol-unix socket=/tmp/runtime-bridge/pulse/native auth-anonymous=1');
    for (const args of [...graph.sinks.values(), ...graph.sources.values(), ...graph.routes]) {
        console.log('load-module', ...args);
    }
    console.log('set-default-sink wa_out');
    console.log('set-default-source ts_mic');
}

module.exports = { createAudioGraph };
