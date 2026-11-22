'use strict';

// Detects whether WhatsApp Web is linked, synced and exposes the call API,
// and recovers whatsapp-web.js state when the page became ready on its own.

const { ClientInfo } = require('whatsapp-web.js');
const state = require('../state');
const { startSerialInterval } = require('../util');

const readyRefreshes = new WeakMap();

async function inspectWhatsAppRuntime(client) {
    if (!client.pupPage || client.pupPage.isClosed()) {
        return { ready: false, reason: 'page is not available' };
    }

    return client.pupPage.evaluate(() => {
        const result = {
            ready: false,
            state: null,
            hasSynced: null,
            wwebjs: false,
            startCall: false,
            startGroupCall: false,
            getActiveCall: false,
            acceptCall: false,
            endCall: false,
            addParticipantToCall: false,
            info: null,
            reason: null,
        };

        try {
            const Socket = window.require('WAWebSocketModel').Socket;
            result.state = Socket.state || null;
            result.hasSynced = Socket.hasSynced === true;
            result.wwebjs = typeof window.WWebJS !== 'undefined';
            result.startCall = typeof window.WWebJS?.startCall === 'function';
            result.startGroupCall =
                typeof window.WWebJS?.startGroupCall === 'function';
            result.getActiveCall =
                typeof window.WWebJS?.getActiveCall === 'function';
            result.acceptCall = typeof window.WWebJS?.acceptCall === 'function';
            result.endCall = typeof window.WWebJS?.endCall === 'function';
            result.addParticipantToCall =
                typeof window.WWebJS?.addParticipantToCall === 'function';
            result.ready = result.hasSynced && result.wwebjs;

            if (result.hasSynced) {
                result.info = {
                    ...window.require('WAWebConnModel').Conn.serialize(),
                    wid:
                        window
                            .require('WAWebUserPrefsMeUser')
                            .getMaybeMePnUser() ||
                        window
                            .require('WAWebUserPrefsMeUser')
                            .getMaybeMeLidUser(),
                };
            }
        } catch (error) {
            result.reason = error && error.message ? error.message : String(error);
        }

        return result;
    });
}

function refreshWhatsAppReady(client) {
    if (readyRefreshes.has(client)) return readyRefreshes.get(client);
    const refresh = updateWhatsAppReady(client).finally(() => readyRefreshes.delete(client));
    readyRefreshes.set(client, refresh);
    return refresh;
}

async function updateWhatsAppReady(client) {
    const runtime = await inspectWhatsAppRuntime(client);

    state.whatsapp = runtime;

    if (!runtime.ready) {
        state.ready = false;
        return false;
    }

    state.awaitingQr = false;

    if (!client.info && runtime.info) {
        client.info = new ClientInfo(client, runtime.info);
    }

    if (
        !state.recoveredEventListenersAttached &&
        typeof client.attachEventListeners === 'function'
    ) {
        await client.attachEventListeners();
        state.recoveredEventListenersAttached = true;
    }

    if (!state.ready) {
        console.log(
            `WhatsApp Web.js recovered ready state: state=${runtime.state} hasSynced=${runtime.hasSynced} wwebjs=${runtime.wwebjs} acceptCall=${runtime.acceptCall} addParticipantToCall=${runtime.addParticipantToCall}`,
        );
    }
    state.ready = true;
    return true;
}

function startReadyPoller(client) {
    if (state.readyPoller) return;
    state.readyPoller = startSerialInterval(async () => {
        if (state.ready) {
            clearInterval(state.readyPoller);
            state.readyPoller = null;
            return;
        }
        await refreshWhatsAppReady(client);
    }, 5000, (error) => {
        console.error(`WhatsApp Web.js ready refresh failed: ${error.message}`);
    });
}

function whatsappStatusText() {
    const runtime = state.whatsapp;
    const awaitingQr = state.awaitingQr ? ' awaitingQr=true (scan QR via noVNC)' : '';
    if (!runtime) return `ready=${state.ready}${awaitingQr}`;
    return [
        `ready=${state.ready}`,
        state.awaitingQr ? 'awaitingQr=true (scan QR via noVNC)' : null,
        `state=${runtime.state || 'unknown'}`,
        `hasSynced=${runtime.hasSynced === true}`,
        `wwebjs=${runtime.wwebjs === true}`,
        `getActiveCallApi=${runtime.getActiveCall === true}`,
        `acceptApi=${runtime.acceptCall === true}`,
        `endApi=${runtime.endCall === true}`,
        `callApi=${runtime.addParticipantToCall === true}`,
        runtime.reason ? `reason=${runtime.reason}` : null,
    ]
        .filter(Boolean)
        .join(' ');
}

module.exports = {
    inspectWhatsAppRuntime,
    refreshWhatsAppReady,
    startReadyPoller,
    whatsappStatusText,
};
