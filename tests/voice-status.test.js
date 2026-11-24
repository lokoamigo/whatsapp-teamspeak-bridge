'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const state = require('../bot/state');
const { bridgeStatusText } = require('../bot/voice-status');
const { WHATSAPP_PULSE_SOURCE } = require('../bot/config');

const stream = (binary, field, target) => ({
    properties: { 'application.process.binary': binary },
    [field]: target,
});

const pulseLists = {
    sinks: [{ name: 'wa_out', index: 1 }, { name: 'ts_out', index: 2 }],
    sources: [{ name: WHATSAPP_PULSE_SOURCE, index: 3 }, { name: 'wa_mic', index: 4 }],
    'sink-inputs': [
        stream('ts3client_linux_amd64', 'sink', 2),
        stream('chromium', 'sink', 1),
    ],
    'source-outputs': [
        stream('ts3client_linux_amd64', 'source', 3),
        stream('chromium', 'source', 3),
    ],
};

test('combined status reports live rooms, readiness and call state without exposing the call ID', async (t) => {
    let teamSpeakRoom = '8';
    let mumbleRoom = { id: 0, name: 'Root' };
    let call = { id: 'private-call-id' };
    let pulseRequests = 0;
    const waClient = {
        pupPage: {
            isClosed: () => false,
            evaluate: async () => ({ ready: true }),
        },
        getActiveCall: async () => call,
    };
    t.mock.method(console, 'log', () => {});
    state.clientQuery = {
        socket: {},
        getOwnClientInfo: async () => ({ cid: teamSpeakRoom }),
        listChannels: async () => [{ id: '8', name: 'Team Lobby' }, { id: '9', name: 'Support' }],
    };
    state.voiceChannels.mumble = {
        request: async (op) => {
            if (op === 'status') return { connected: true, captureReady: true, playbackReady: false };
            assert.equal(op, 'current_channel');
            return mumbleRoom;
        },
    };
    const pactl = async ([format, list, type]) => {
        assert.deepEqual([format, list], ['--format=json', 'list']);
        pulseRequests += 1;
        return JSON.stringify(pulseLists[type]);
    };
    const status = bridgeStatusText(waClient, { pactl });
    assert.equal(bridgeStatusText(waClient, { pactl }), status);
    assert.equal(await status, [
        'WhatsApp ready call=active capture=ready playback=ready',
        'TeamSpeak connected room="Team Lobby" capture=misrouted playback=ready',
        'Mumble connected room="Root" capture=ready playback=unavailable',
    ].join('\n'));
    assert.equal(pulseRequests, 4);

    teamSpeakRoom = '9';
    mumbleRoom = { id: 2, name: 'Support' };
    call = null;
    assert.match(await bridgeStatusText(waClient, { pactl }),
        /WhatsApp ready call=idle[^\n]*\nTeamSpeak connected room="Support"[^\n]*\nMumble connected room="Support"/);
    assert.equal(pulseRequests, 8);
});

test('unavailable probes do not hide the state of other endpoints', async () => {
    state.awaitingQr = true;
    state.clientQuery = {
        socket: {},
        getOwnClientInfo: async () => { throw new Error('error id=1794 msg=not\\sconnected'); },
    };
    state.voiceChannels.mumble = {
        request: async (op) => {
            if (op === 'status') return { connected: true, captureReady: true, playbackReady: true };
            throw new Error('Unknown native Mumble operation');
        },
    };
    const waClient = { getActiveCall: () => assert.fail('call probe while waiting for QR') };
    const pactl = async () => { throw new Error('PulseAudio unavailable'); };
    assert.equal(await bridgeStatusText(waClient, { pactl }), [
        'WhatsApp QR required call=unknown capture=unknown playback=unknown',
        'TeamSpeak disconnected capture=unknown playback=unknown',
        'Mumble connected room=unknown capture=ready playback=ready',
    ].join('\n'));
});
