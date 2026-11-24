'use strict';

const { RecentSet } = require('./recent-set');

// Mutable runtime state shared by the WhatsApp, TeamSpeak and API modules.
// Modules mutate properties on this single object; never reassign the export.
const state = {
    ready: false,
    whatsapp: null,
    recoveredEventListenersAttached: false,
    activeCallId: null,
    activeCall: null,
    micStabilizationRunId: 0,
    autoAcceptingCallIds: new Set(),
    autoAcceptedCallIds: new RecentSet(256),
    lastAutoAcceptPollErrorAt: 0,
    awaitingQr: false,
    readyPoller: null,
    clientQuery: null,
    // Channel controls keyed by server, see voice-channels.js.
    voiceChannels: {},
    channelPolls: new Map(),
    pendingChannelPolls: [],
};

module.exports = state;
