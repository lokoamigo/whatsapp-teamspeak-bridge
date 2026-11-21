'use strict';

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
    autoAcceptedCallIds: new Set(),
    lastAutoAcceptPollErrorAt: 0,
    awaitingQr: false,
    readyPoller: null,
    clientQuery: null,
    // Channel control and chat of the active voice backend, see voice-channels.js.
    voiceChannels: null,
    channelPolls: new Map(),
    pendingChannelPolls: [],
};

module.exports = state;
