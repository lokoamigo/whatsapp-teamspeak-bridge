'use strict';

// Entry point. Module map:
//   config.js / state.js   env settings and shared runtime state
//   commands.js            `!wa` command set (TeamSpeak and Mumble)
//   contacts.js            phone-number normalisation and contact groups
//   whatsapp/              WhatsApp Web client, calls, microphone, polls
//   teamspeak/             ClientQuery connection and command listener
//   mumble/                Mumble protocol client and command bot
//   audio/pulse.js         PulseAudio helpers
//   api/server.js          local HTTP API

const { CALL_ANNOUNCEMENTS, CHAT_RELAY, COMBINED_VOICE, COMMAND_PREFIX, PRESENCE_NOTICES, VOICE_BACKEND } = require('./config');
const { createApiServer } = require('./api/server');
const { startAudioRouter } = require('./audio/router');
const { createChatRelay } = require('./chat-relay');
const { createPresence } = require('./presence');
const state = require('./state');
const { runMumbleCommandBot } = require('./mumble/command-listener');
const { runTeamSpeakCommandListener } = require('./teamspeak/command-listener');
const { startCallAnnouncements } = require('./whatsapp/call-announcements');
const { createWhatsAppClient } = require('./whatsapp/client');

// Errors Puppeteer raises when a WhatsApp Web navigation (e.g. the multi-step
// logout flow) destroys the page context an in-flight call was using. The
// next navigation re-runs the affected logic, so these must not kill the bot.
const NAVIGATION_RACE_ERROR_PATTERNS = [
    /Execution context was destroyed/i,
    /Cannot find context with specified id/i,
    /Target closed/i,
    /Session closed/i,
    /Protocol error\b.*\bdetached/i,
    /Navigating frame was detached/i,
    /Attempted to use detached Frame/i,
];

function isNavigationRaceError(error) {
    const message = String((error && error.message) || error || '');
    return NAVIGATION_RACE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

// Last line of defence against library bugs that leave a promise rejection
// unhandled (Node >= 15 terminates on those). Navigation races are survivable;
// anything else keeps the fail-fast behaviour so supervisor restarts the bot.
process.on('unhandledRejection', (reason) => {
    if (isNavigationRaceError(reason)) {
        console.error(
            `Ignoring unhandled WhatsApp Web navigation race: ${(reason && reason.message) || reason}`,
        );
        return;
    }
    console.error('Unhandled promise rejection; exiting so supervisor restarts the bot:');
    console.error(reason);
    process.exit(1);
});

async function main() {
    startAudioRouter();
    const waClient = await createWhatsAppClient();
    createApiServer(waClient);
    if (CALL_ANNOUNCEMENTS) startCallAnnouncements(waClient);

    if (COMBINED_VOICE) {
        const relay = CHAT_RELAY || PRESENCE_NOTICES ? createChatRelay({ commandPrefix: COMMAND_PREFIX }) : undefined;
        const chatRelay = CHAT_RELAY ? relay : undefined;
        if (PRESENCE_NOTICES) {
            createPresence({
                announce: relay.announce,
                sides: {
                    teamspeak: {
                        label: 'TS',
                        poll: () => state.clientQuery.listChannelRoster(),
                        sendPrivate: (user, text) => state.clientQuery.sendPrivateMessage(user.clid, text),
                    },
                    mumble: {
                        label: 'Mumble',
                        poll: () => state.voiceChannels.mumble.roster(),
                        sendPrivate: (user, text) => state.voiceChannels.mumble.sendPrivateMessage(user.session, text),
                    },
                },
            }).start();
        }
        await Promise.all([
            runTeamSpeakCommandListener(waClient, { chatRelay }),
            runMumbleCommandBot(waClient, { chatRelay }),
        ]);
        return;
    }
    if (VOICE_BACKEND === 'mumble') {
        await runMumbleCommandBot(waClient);
        return;
    }

    await runTeamSpeakCommandListener(waClient);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
