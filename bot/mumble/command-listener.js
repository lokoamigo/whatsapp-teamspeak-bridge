'use strict';

// Runs the Mumble chat bot that answers `!wa` commands in Mumble mode and
// provides Mumble channel switching for `!switchChannel`.

const {
    BRIDGE_VERSION,
    COMMAND_PREFIX,
    COMMANDER_UIDS,
    MUMBLE_BOT_DATA_DIR,
    MUMBLE_BOT_URI,
    MUMBLE_URI,
    MUMBLE_CLIENT,
    MUMBLE_NATIVE_SOCKET,
} = require('../config');
const state = require('../state');
const { parseArgs } = require('../util');
const { extractCommand, handleCommand } = require('../commands');
const { createMumbleChannelControl } = require('./channels');
const { createMumbleCommandBot, getMumbleBotConfig } = require('./commands');
const { createNativeMumbleControl } = require('./native');

async function runMumbleCommandBot(waClient) {
    if (MUMBLE_CLIENT === 'native') {
        const client = createNativeMumbleControl({
            socketPath: MUMBLE_NATIVE_SOCKET,
            commandPrefix: COMMAND_PREFIX,
            commanderIds: COMMANDER_UIDS,
            extractCommand,
            parseArgs,
            handleCommand: (args) => handleCommand(waClient, args),
        });
        state.voiceChannels.mumble = client;
        await client.run();
        return;
    }
    let config;
    try {
        config = getMumbleBotConfig(MUMBLE_URI, MUMBLE_BOT_URI);
    } catch (error) {
        console.error(`Mumble command control disabled: ${error.message}`);
        return;
    }
    if (!config) {
        console.log('MUMBLE_URI is not set; WhatsApp is running without Mumble command control.');
        return;
    }
    const bot = createMumbleCommandBot({
        config,
        dataDir: MUMBLE_BOT_DATA_DIR,
        release: `whatsapp-teamspeak-bridge ${BRIDGE_VERSION}`,
        commandPrefix: COMMAND_PREFIX,
        commanderIds: COMMANDER_UIDS,
        extractCommand,
        parseArgs,
        handleCommand: (args) => handleCommand(waClient, args),
    });
    state.voiceChannels.mumble = createMumbleChannelControl({
        getClient: () => bot.client,
        bridgeUsername: config.bridgeUsername,
        botUsername: config.username,
    });
    await bot.run();
}

module.exports = { runMumbleCommandBot };
