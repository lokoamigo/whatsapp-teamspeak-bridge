'use strict';

// TeamSpeak channel control for `!switchChannel` (see ../voice-channels.js),
// backed by the active ClientQuery connection.

const state = require('../state');

function requireClientQuery() {
    const query = state.clientQuery;
    if (!query || !query.socket || query.socket.destroyed) {
        throw new Error('TeamSpeak ClientQuery is not connected.');
    }
    return query;
}

const teamSpeakChannels = {
    listSwitchableChannels: () => requireClientQuery().listSwitchableChannels(),
    moveToChannel: (channel) => requireClientQuery().moveSelfToChannel(channel),
};

module.exports = { requireClientQuery, teamSpeakChannels };
