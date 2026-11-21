'use strict';

// Channel lookup and switching through the active ClientQuery connection.

const { VOICE_BACKEND } = require('../config');
const state = require('../state');

function requireClientQuery() {
    if (VOICE_BACKEND === 'mumble') {
        throw new Error('Channel switching is only available with the TeamSpeak backend.');
    }
    const query = state.clientQuery;
    if (!query || !query.socket || query.socket.destroyed) {
        throw new Error('TeamSpeak ClientQuery is not connected.');
    }
    return query;
}

function findChannelByName(channels, requestedName) {
    const normalized = requestedName.trim().toLowerCase();
    return channels.filter((channel) => channel.name.toLowerCase() === normalized);
}

async function switchToChannelByName(channelName) {
    if (!channelName) throw new Error('Missing TeamSpeak channel name.');

    const query = requireClientQuery();
    const channels = await query.listSwitchableChannels();
    const matches = findChannelByName(channels, channelName);
    if (matches.length === 0) {
        throw new Error(`TeamSpeak channel not found or already active: ${channelName}`);
    }
    if (matches.length > 1) {
        throw new Error(`TeamSpeak channel name is ambiguous: ${channelName}`);
    }

    await query.moveSelfToChannel(matches[0]);
    return matches[0];
}

module.exports = { requireClientQuery, findChannelByName, switchToChannelByName };
