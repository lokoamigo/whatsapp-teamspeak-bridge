'use strict';

// Backend-neutral channel control for `!switchChannel` and call
// announcements. The active voice backend registers it in state.voiceChannels:
//
//   listSwitchableChannels(): Promise<Array<{ id, name }>>
//       channels the bridge client can move to (its current one excluded)
//   moveToChannel(channel): Promise<void>
//       moves the bridge client, resolving once the server confirmed it
//   sendChannelMessage(text): Promise<void>
//       posts a chat message to the bridge client's current channel

const { VOICE_BACKEND_LABEL } = require('./config');
const state = require('./state');

function requireVoiceChannels() {
    if (!state.voiceChannels) {
        throw new Error(
            `${VOICE_BACKEND_LABEL} channel switching is not available: the ${VOICE_BACKEND_LABEL} command connection is not configured.`,
        );
    }
    return state.voiceChannels;
}

function findChannelByName(channels, requestedName) {
    const normalized = requestedName.trim().toLowerCase();
    return channels.filter((channel) => channel.name.toLowerCase() === normalized);
}

async function switchToChannelByName(channelName) {
    if (!channelName) throw new Error(`Missing ${VOICE_BACKEND_LABEL} channel name.`);

    const voiceChannels = requireVoiceChannels();
    const channels = await voiceChannels.listSwitchableChannels();
    const matches = findChannelByName(channels, channelName);
    if (matches.length === 0) {
        throw new Error(
            `${VOICE_BACKEND_LABEL} channel not found or already active: ${channelName}`,
        );
    }
    if (matches.length > 1) {
        throw new Error(`${VOICE_BACKEND_LABEL} channel name is ambiguous: ${channelName}`);
    }

    await voiceChannels.moveToChannel(matches[0]);
    return matches[0];
}

module.exports = { requireVoiceChannels, findChannelByName, switchToChannelByName };
