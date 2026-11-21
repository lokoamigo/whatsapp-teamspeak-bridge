'use strict';

// Receives `!wa` text messages through ClientQuery and keeps the connection
// alive across TeamSpeak client restarts.

const { TS_API_KEY } = require('../config');
const state = require('../state');
const { parseArgs, sleep } = require('../util');
const { assertCommander, extractCommand, handleCommand } = require('../commands');
const { ClientQuery } = require('./client-query');

async function runTeamSpeakCommandListener(waClient) {
    if (!TS_API_KEY) {
        console.log('TS3_CLIENTQUERY_API_KEY is not set; WhatsApp is running without TeamSpeak command control.');
        return;
    }

    while (true) {
        try {
            const query = new ClientQuery();
            await query.connect();
            state.clientQuery = query;

            query.onTextMessage = async (event) => {
                if (query.ownClientId && event.invokerid === query.ownClientId) return;

                console.log(
                    `TeamSpeak message from ${event.invokername || event.invokeruid || event.invokerid}: ${event.msg || ''}`,
                );

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

            while (true) {
                const closed = await Promise.race([
                    query.closed.then(() => 'closed'),
                    sleep(5000).then(() => 'poll'),
                ]);
                if (closed === 'closed') break;

                try {
                    await query.refreshServerHandlerRegistration();
                } catch (error) {
                    console.error(`ClientQuery server handler not ready: ${error.message}`);
                }
            }
            console.error('ClientQuery command listener disconnected; reconnecting.');
            if (state.clientQuery === query) state.clientQuery = null;
        } catch (error) {
            console.error(`ClientQuery command listener not ready: ${error.message}`);
            state.clientQuery = null;
        }
        await sleep(5000);
    }
}

module.exports = { runTeamSpeakCommandListener };
