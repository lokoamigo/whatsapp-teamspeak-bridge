'use strict';

// Backend-neutral channel control for voice room switching and call
// announcements. Each active backend registers it in state.voiceChannels:
//
//   listSwitchableChannels(): Promise<Array<{ id, name }>>
//       channels the bridge client can move to (its current one excluded)
//   moveToChannel(channel): Promise<void>
//       moves the bridge client, resolving once the server confirmed it
//   sendChannelMessage(text): Promise<void>
//       posts a chat message to the bridge client's current channel

const { VOICE_BACKEND, VOICE_BACKEND_LABEL } = require('./config');
const state = require('./state');

const VOICE_CHANNEL_LABELS = new Map([
    ['teamspeak', 'TeamSpeak'],
    ['mumble', 'Mumble'],
]);
const moveQueues = new Map();
const MAX_PENDING_MOVES = 8;

function requireVoiceChannels(backend = VOICE_BACKEND) {
    const control = state.voiceChannels[backend];
    if (!control) {
        const label = VOICE_CHANNEL_LABELS.get(backend) || VOICE_BACKEND_LABEL;
        throw new Error(
            `${label} channel switching is not available: the ${label} command connection is not configured.`,
        );
    }
    return control;
}

function findChannelByName(channels, requestedName) {
    const normalized = requestedName.trim().toLowerCase();
    return channels.filter((channel) => channel.name.toLowerCase() === normalized);
}

async function switchToChannelByName(channelName, backend = VOICE_BACKEND, moveOptions) {
    const label = VOICE_CHANNEL_LABELS.get(backend) || VOICE_BACKEND_LABEL;
    if (!channelName) throw new Error(`Missing ${label} channel name.`);

    const voiceChannels = requireVoiceChannels(backend);
    const channels = await voiceChannels.listSwitchableChannels();
    const matches = findChannelByName(channels, channelName);
    if (matches.length === 0) {
        throw new Error(
            `${label} channel not found or already active: ${channelName}`,
        );
    }
    if (matches.length > 1) {
        throw new Error(`${label} channel name is ambiguous: ${channelName}`);
    }

    await voiceChannels.moveToChannel(matches[0], moveOptions);
    return matches[0];
}

async function switchCombinedVoiceChannel(backend, channelName) {
    let queue = moveQueues.get(backend);
    if (!queue) {
        queue = { tail: Promise.resolve(), pending: 0 };
        moveQueues.set(backend, queue);
    }
    if (queue.pending >= MAX_PENDING_MOVES) {
        throw new Error('The channel switch queue is full. Please retry.');
    }
    queue.pending++;
    // Resolve the room at the front of the queue so it reflects previous moves.
    const move = queue.tail.then(() =>
        switchToChannelByName(channelName, backend, { allowReconnect: false }),
    );
    queue.tail = move.catch(() => {});
    try {
        return await move;
    } finally {
        queue.pending--;
        if (queue.pending === 0) moveQueues.delete(backend);
    }
}

module.exports = {
    VOICE_CHANNEL_LABELS, requireVoiceChannels, findChannelByName,
    switchToChannelByName, switchCombinedVoiceChannel,
};
