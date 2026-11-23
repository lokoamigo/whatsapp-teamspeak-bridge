'use strict';

const { mumbleHtmlToText } = require('./client');

// Both GUI mode's deaf bot and the native audio/chat account use this command
// path. Sender hashes are provided by the Mumble server, never by chat text.
function createMumbleCommandHandler({
    commandPrefix, commanderIds, extractCommand, parseArgs, handleCommand, log = console,
}) {
    const commanders = new Set([...commanderIds].map((value) => String(value).trim().toLowerCase()));
    let running = 0;
    return async function onMessage(event, reply) {
        const text = mumbleHtmlToText(event.message);
        let command;
        if (event.private) command = extractCommand(text);
        else {
            const trimmed = String(text || '').trim();
            command = trimmed.startsWith(commandPrefix) && /\s/.test(trimmed[commandPrefix.length])
                ? trimmed.slice(commandPrefix.length).trim() : null;
        }
        if (!command) return;
        if (running >= 8) { await reply('The WhatsApp bridge is busy; please retry.'); return; }
        running += 1;
        try {
            let response;
            try {
                const hash = String(event.user?.hash || '').toLowerCase();
                if (commanders.size && !commanders.has(hash)) {
                    throw new Error(hash
                        ? `You are not allowed to control the WhatsApp bridge (your certificate hash: ${hash}).`
                        : 'You are not allowed to control the WhatsApp bridge (connect with a Mumble certificate).');
                }
                log.log(`Mumble command from ${event.user?.name || `session ${event.actor}`}: ${text}`);
                response = await handleCommand(parseArgs(command));
            } catch (error) {
                response = `Error: ${error.message}`;
            }
            await reply(response);
        } finally {
            running -= 1;
        }
    };
}

module.exports = { createMumbleCommandHandler };
