'use strict';

// Receives `!wa` text messages through ClientQuery and keeps the connection
// alive across TeamSpeak client restarts.

const { TS_API_KEY } = require('../config');
const state = require('../state');
const { parseArgs, sleep, startSerialInterval } = require('../util');
const { assertCommander, extractCommand, handleCommand } = require('../commands');
const { teamSpeakChannels } = require('./channels');
const { ClientQuery } = require('./client-query');

async function runTeamSpeakCommandListener(waClient, { chatRelay } = {}) {
    state.voiceChannels.teamspeak = teamSpeakChannels;

    if (!TS_API_KEY) {
        console.log('TS3_CLIENTQUERY_API_KEY is not set; WhatsApp is running without TeamSpeak command control.');
        return;
    }

    while (true) {
        const query = new ClientQuery();
        let heartbeat;
        try {
            await query.connect();
            state.clientQuery = query;

            query.onTextMessage = async (event) => {
                if (query.ownClientId && event.invokerid === query.ownClientId) return;

                console.log(
                    `TeamSpeak message from ${event.invokername || event.invokeruid || event.invokerid}: ${event.msg || ''}`,
                );

                if (chatRelay) chatRelay.fromTeamSpeak(event, { ownClientId: query.ownClientId });

                const commandText = extractCommand(event.msg || '');
                if (!commandText) return;

                try {
                    assertCommander(event);
                    const args = parseArgs(commandText);
                    const response = await handleCommand(waClient, args);
                    await query.reply(event, response);
                } catch (error) {
                    await query.reply(event, `Error: ${error.message}`);
                }
            };

            heartbeat = startSerialInterval(
                () => query.refreshServerHandlerRegistration(),
                5000,
                (error) => {
                    console.error(`ClientQuery server handler not ready: ${error.message}`);
                },
            );
            // Subscribe once for this connection. Repeated Promise.race calls
            // retain their losing callbacks until the connection finally closes.
            await query.closed;
            console.error('ClientQuery command listener disconnected; reconnecting.');
        } catch (error) {
            console.error(`ClientQuery command listener not ready: ${error.message}`);
        } finally {
            clearInterval(heartbeat);
            query.socket?.destroy();
            if (state.clientQuery === query) state.clientQuery = null;
        }
        await sleep(5000);
    }
}

module.exports = { runTeamSpeakCommandListener };
