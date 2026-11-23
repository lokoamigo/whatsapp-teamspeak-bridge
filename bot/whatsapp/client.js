'use strict';

// Creates the bot-owned WhatsApp Web client (the only Chromium controller in
// the container) and wires its events to the bridge modules.

const { Client, NoAuth } = require('whatsapp-web.js');
const {
    AUTO_ACCEPT_POLL_MS,
    CHROMIUM_EXECUTABLE,
    CHROMIUM_PROFILE,
    DISPLAY_HEIGHT,
    DISPLAY_WIDTH,
    FORCE_WEB_CALLING,
} = require('../config');
const state = require('../state');
const { startSerialInterval } = require('../util');
const { autoAcceptIncomingCall, pollIncomingWhatsAppCall } = require('./calls');
const {
    handleWhatsAppMessageCreate,
    handleWhatsAppPollVote,
    startChannelPollCleanup,
} = require('./channel-polls');
const { handleWhatsAppMessage } = require('./messages');
const { grantWhatsAppMicrophonePermission } = require('./microphone');
const { attachWhatsAppPollVoteBridge } = require('./poll-vote-hook');
const { refreshWhatsAppReady, startReadyPoller } = require('./readiness');

async function createWhatsAppClient() {
    startChannelPollCleanup();
    const headless = process.env.BRIDGE_BROWSER_MODE === 'headless';
    const client = new Client({
        authStrategy: new NoAuth(),
        forceWebCalling: FORCE_WEB_CALLING,
        userAgent: false,
        webVersionCache: {
            type: 'local',
            path: '/data/wwebjs_cache',
        },
        puppeteer: {
            executablePath: CHROMIUM_EXECUTABLE,
            headless,
            // Puppeteer otherwise mutes headless playback.
            ignoreDefaultArgs: headless ? ['--mute-audio'] : undefined,
            defaultViewport: null,
            userDataDir: CHROMIUM_PROFILE,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer=false',
                '--no-first-run',
                '--no-default-browser-check',
                '--password-store=basic',
                '--remote-debugging-address=0.0.0.0',
                '--remote-debugging-port=9222',
                '--remote-allow-origins=*',
                '--alsa-output-device=default',
                '--alsa-input-device=default',
                '--use-fake-ui-for-media-stream',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-session-crashed-bubble',
                `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
                ...(headless ? [] : ['--start-maximized']),
            ],
        },
        takeoverOnConflict: false,
        qrMaxRetries: 0,
        authTimeoutMs: 120000,
    });

    client.on('ready', () => {
        state.ready = true;
        state.whatsapp = null;
        state.recoveredEventListenersAttached = true;
        console.log('WhatsApp Web.js bot is ready.');
        client.pupPage
            .evaluate(() => navigator.userAgent)
            .then((userAgent) => {
                console.log(`WhatsApp Web runtime user agent: ${userAgent}`);
            })
            .catch((error) => {
                console.error(
                    `Could not read WhatsApp Web runtime user agent: ${error.message}`,
                );
            });
        attachWhatsAppPollVoteBridge(client).catch((error) => {
            console.error(`Could not attach WhatsApp poll vote bridge: ${error.message}`);
        });
        grantWhatsAppMicrophonePermission(client, 'ready').catch((error) => {
            console.error(
                `Could not pre-grant WhatsApp microphone permission: ${error.message}`,
            );
        });
    });

    client.on('qr', () => {
        // WhatsApp refreshes the QR code every ~20 s; only announce the first.
        if (state.awaitingQr) return;
        state.awaitingQr = true;
        console.log(headless
            ? 'WhatsApp is not linked. Run bridge-browser-mode maintenance and scan the QR code with noVNC.'
            : 'WhatsApp is not linked: scan the QR code shown in Chromium via noVNC (port 6080) with WhatsApp > Linked devices.');
    });

    client.on('authenticated', () => {
        state.awaitingQr = false;
        console.log('WhatsApp Web.js authenticated.');
        setTimeout(() => {
            refreshWhatsAppReady(client).catch((error) => {
                console.error(`WhatsApp Web.js ready refresh failed: ${error.message}`);
            });
        }, 1000);
    });

    client.on('auth_failure', (message) => {
        console.error(`WhatsApp auth failure: ${message}`);
    });

    client.on('disconnected', (reason) => {
        state.ready = false;
        state.activeCallId = null;
        state.activeCall = null;
        console.error(`WhatsApp Web.js disconnected: ${reason}`);
        if (reason === 'LOGOUT') {
            // WhatsApp ended the linked-device session (e.g. removed on the
            // phone). WhatsApp Web clears its own session data and shows a new
            // QR code in the same Chromium window; the bot keeps running.
            // The Chromium profile is deliberately left untouched.
            console.error(headless
                ? 'WhatsApp linked device logged out. Run bridge-browser-mode maintenance to re-link it with noVNC.'
                : 'WhatsApp linked device logged out. Open noVNC (port 6080) and scan the QR code in Chromium with WhatsApp > Linked devices.');
            // A new session needs the same ready recovery as a fresh start.
            state.recoveredEventListenersAttached = false;
            startReadyPoller(client);
        }
    });

    client.on('call', (call) => {
        state.activeCall = call;
        state.activeCallId = call.id;
        console.log(
            `WhatsApp call observed: id=${call.id} from=${call.from} group=${call.isGroup} video=${call.isVideo} outgoing=${call.fromMe}`,
        );
        autoAcceptIncomingCall(client, call);
    });

    client.on('message', (message) => {
        handleWhatsAppMessage(client, message).catch((error) => {
            console.error(`WhatsApp message handler failed: ${error.message}`);
        });
    });

    client.on('message_create', (message) => {
        handleWhatsAppMessageCreate(message);
    });

    client.on('vote_update', (vote) => {
        handleWhatsAppPollVote(client, vote).catch((error) => {
            console.error(`WhatsApp poll vote handler failed: ${error.message}`);
        });
    });

    await client.initialize();
    await grantWhatsAppMicrophonePermission(client, 'initialize');
    // The page can still be navigating here (e.g. after a logout); the ready
    // poller retries, so a failed first check must not abort the startup.
    await refreshWhatsAppReady(client).catch((error) => {
        console.error(`WhatsApp Web.js ready refresh failed: ${error.message}`);
    });
    startReadyPoller(client);

    startSerialInterval(
        () => pollIncomingWhatsAppCall(client),
        AUTO_ACCEPT_POLL_MS,
        (error) => {
            const now = Date.now();
            if (now - state.lastAutoAcceptPollErrorAt > 30000) {
                console.error(`WhatsApp auto-accept poll failed: ${error.message}`);
                state.lastAutoAcceptPollErrorAt = now;
            }
        },
    );

    return client;
}

module.exports = { createWhatsAppClient };
