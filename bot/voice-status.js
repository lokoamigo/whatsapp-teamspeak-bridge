'use strict';

const { WHATSAPP_PULSE_SOURCE } = require('./config');
const state = require('./state');
const { runPactl } = require('./audio/pulse');
const { requireClientQuery } = require('./teamspeak/channels');
const { getActiveWhatsAppCall } = require('./whatsapp/calls');
const { refreshWhatsAppReady } = require('./whatsapp/readiness');

const statusRequests = new WeakMap();

async function pulseStreams(pactl) {
    const read = async (type) => JSON.parse(await pactl(['--format=json', 'list', type]));
    const [sinks, sources, playback, capture] = await Promise.all([
        read('sinks'), read('sources'), read('sink-inputs'), read('source-outputs'),
    ]);
    return { sinks, sources, playback, capture };
}

function streamStatus(devices, streams, device, field, binary) {
    const index = devices.find((entry) => entry.name === device)?.index;
    if (index === undefined) return 'unavailable';
    const matching = streams.filter((stream) => stream.properties?.['application.process.binary'] === binary);
    if (matching.length === 0) return 'idle';
    return matching.every((stream) => Number(stream[field]) === index) ? 'ready' : 'misrouted';
}

function pulseStatus(snapshot, binary, sink, source) {
    if (!snapshot) return 'capture=unknown playback=unknown';
    return [
        `capture=${streamStatus(snapshot.sources, snapshot.capture, source, 'source', binary)}`,
        `playback=${streamStatus(snapshot.sinks, snapshot.playback, sink, 'sink', binary)}`,
    ].join(' ');
}

function roomText(room) {
    // Keep one endpoint per line even if a channel name contains a newline.
    return room?.name ? JSON.stringify(room.name) : room?.id != null ? `#${room.id}` : 'unknown';
}

async function teamSpeakStatus(snapshot) {
    const audio = pulseStatus(snapshot, 'ts3client_linux_amd64', 'ts_out', 'wa_mic');
    let query;
    let ownInfo;
    try {
        query = requireClientQuery();
        ownInfo = await query.getOwnClientInfo();
    } catch (error) {
        const connection = /not(?:\\s| )connected/i.test(error.message) &&
            query ? 'disconnected' : 'connection=unknown';
        return `TeamSpeak ${connection} ${audio}`;
    }
    const id = ownInfo.cid || ownInfo.client_channel_id;
    if (!id) return `TeamSpeak connection=unknown ${audio}`;
    const channels = await query.listChannels().catch(() => []);
    const room = channels.find((channel) => channel.id === id) || { id };
    return `TeamSpeak connected room=${roomText(room)} ${audio}`;
}

async function mumbleStatus() {
    const unavailable = 'Mumble connection=unknown capture=unknown playback=unknown';
    const control = state.voiceChannels.mumble;
    if (typeof control?.request !== 'function') return unavailable;
    const status = await control.request('status').catch(() => null);
    if (!status) return unavailable;
    const audio = [
        `capture=${status.captureReady ? 'ready' : 'unavailable'}`,
        `playback=${status.playbackReady ? 'ready' : 'unavailable'}`,
    ].join(' ');
    if (!status.connected) return `Mumble disconnected ${audio}`;
    const room = await control.request('current_channel').catch(() => null);
    return `Mumble connected room=${roomText(room)} ${audio}`;
}

async function whatsAppStatus(waClient, snapshot) {
    const ready = await refreshWhatsAppReady(waClient).catch(() => false);
    const audio = pulseStatus(snapshot, 'chromium', 'wa_out', WHATSAPP_PULSE_SOURCE);
    if (!ready) {
        const availability = state.awaitingQr ? 'QR required' : 'not ready';
        return `WhatsApp ${availability} call=unknown ${audio}`;
    }
    let call = 'unknown';
    if (typeof waClient.getActiveCall === 'function') {
        try {
            call = await getActiveWhatsAppCall(waClient) ? 'active' : 'idle';
        } catch (_) {
            // Navigation can invalidate just the call probe between reads.
        }
    }
    return `WhatsApp ready call=${call} ${audio}`;
}

function bridgeStatusText(waClient, { pactl = runPactl } = {}) {
    if (statusRequests.has(waClient)) return statusRequests.get(waClient);
    const snapshot = pulseStreams(pactl).catch(() => null);
    const refresh = Promise.all([
        snapshot.then((streams) => whatsAppStatus(waClient, streams)),
        snapshot.then(teamSpeakStatus),
        mumbleStatus(),
    ]).then((lines) => lines.join('\n')).finally(() => statusRequests.delete(waClient));
    statusRequests.set(waClient, refresh);
    return refresh;
}

module.exports = { bridgeStatusText };
