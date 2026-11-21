'use strict';

// WhatsApp call lifecycle: active-call lookup, participants, accept and
// auto-accept of incoming calls.

const state = require('../state');
const { sleep } = require('../util');
const { refreshWhatsAppMicrophone } = require('../audio/pulse');
const {
    grantWhatsAppMicrophonePermission,
    scheduleWhatsAppCallMicrophoneStabilization,
} = require('./microphone');
const { refreshWhatsAppReady } = require('./readiness');

async function getActiveWhatsAppCall(waClient) {
    if (typeof waClient.getActiveCall !== 'function') return null;
    return waClient.getActiveCall();
}

async function getActiveWhatsAppCallId(waClient) {
    const activeCall = await getActiveWhatsAppCall(waClient);
    const activeCallId = activeCall?.id || null;

    state.activeCallId = activeCallId;
    state.activeCall = activeCall || null;
    return activeCallId;
}

async function getLiveWhatsAppCallStatus(waClient) {
    const activeCall = await getActiveWhatsAppCall(waClient);
    state.activeCall = activeCall || null;
    state.activeCallId = activeCall?.id || null;
    if (!activeCall) {
        return {
            active: false,
            callId: null,
            participantCount: 0,
            totalParticipantCount: 0,
        };
    }

    const reportedParticipantCount =
        await waClient.getActiveCallParticipantCount();
    const totalParticipantCount =
        Number.isSafeInteger(reportedParticipantCount) &&
        reportedParticipantCount >= 0
            ? reportedParticipantCount
            : null;
    return {
        active: true,
        callId: activeCall.id || null,
        // The fork returns WhatsApp's complete roster, including this bridge
        // account. This API's participantCount is intentionally the number of
        // remote players; retain the raw total for callers that need it.
        participantCount:
            totalParticipantCount === null
                ? null
                : Math.max(0, totalParticipantCount - 1),
        totalParticipantCount,
    };
}

// Newer WhatsApp Web builds dropped WAWebUserPrefsMeUser.isMeAccount, which the
// pinned whatsapp-web.js fork still calls before starting a call. Restore it
// from the remaining getMaybeMe*User helpers when it is missing.
async function ensureWhatsAppIsMeAccountShim(waClient) {
    const result = await waClient.pupPage.evaluate(() => {
        const meUser = window.require('WAWebUserPrefsMeUser');
        if (typeof meUser.isMeAccount === 'function') return 'native';

        const isMeAccount = (wid) => {
            if (!wid) return false;
            const me = [meUser.getMaybeMePnUser?.(), meUser.getMaybeMeLidUser?.()].filter(
                Boolean,
            );
            return me.some(
                (own) =>
                    (typeof own.equals === 'function' && own.equals(wid)) ||
                    (own.user === wid.user && own.server === wid.server),
            );
        };
        try {
            meUser.isMeAccount = isMeAccount;
        } catch (_) {
            // Fall through to defineProperty for non-writable module exports.
        }
        if (typeof meUser.isMeAccount !== 'function') {
            Object.defineProperty(meUser, 'isMeAccount', {
                value: isMeAccount,
                configurable: true,
                writable: true,
            });
        }
        return typeof meUser.isMeAccount === 'function' ? 'shimmed' : 'failed';
    });
    if (result === 'failed') {
        throw new Error('Could not restore WAWebUserPrefsMeUser.isMeAccount in WhatsApp Web.');
    }
    if (result === 'shimmed') {
        console.log('Patched missing WAWebUserPrefsMeUser.isMeAccount in WhatsApp Web.');
    }
}

async function getActiveWhatsAppCall(waClient) {
    if (typeof waClient.getActiveCall !== 'function') return null;
    return waClient.getActiveCall();
}

async function getActiveWhatsAppCallId(waClient) {
    const activeCall = await getActiveWhatsAppCall(waClient);
    const activeCallId = activeCall?.id || null;

    state.activeCallId = activeCallId;
    state.activeCall = activeCall || null;
    return activeCallId;
}

async function getLiveWhatsAppCallStatus(waClient) {
    const activeCall = await getActiveWhatsAppCall(waClient);
    state.activeCall = activeCall || null;
    state.activeCallId = activeCall?.id || null;
    if (!activeCall) {
        return {
            active: false,
            callId: null,
            participantCount: 0,
            totalParticipantCount: 0,
        };
    }

    const reportedParticipantCount =
        await waClient.getActiveCallParticipantCount();
    const totalParticipantCount =
        Number.isSafeInteger(reportedParticipantCount) &&
        reportedParticipantCount >= 0
            ? reportedParticipantCount
            : null;
    return {
        active: true,
        callId: activeCall.id || null,
        // The fork returns WhatsApp's complete roster, including this bridge
        // account. This API's participantCount is intentionally the number of
        // remote players; retain the raw total for callers that need it.
        participantCount:
            totalParticipantCount === null
                ? null
                : Math.max(0, totalParticipantCount - 1),
        totalParticipantCount,
    };
}

async function addParticipantsToActiveCall(waClient, contactIds) {
    const activeCallId = await getActiveWhatsAppCallId(waClient);
    if (!activeCallId) {
        throw new Error('No active WhatsApp call is available to add participants.');
    }

    for (const contactId of contactIds) {
        await waClient.addParticipantToCall(contactId, activeCallId);
    }
    return activeCallId;
}

async function acceptActiveWhatsAppCall(waClient, call = null, options = {}) {
    const attempts = options.attempts || 1;
    const delayMs = options.delayMs || 0;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const activeCall =
                call && typeof call.accept === 'function'
                    ? call
                    : await getActiveWhatsAppCall(waClient);
            if (!activeCall || typeof activeCall.accept !== 'function') {
                throw new Error('No active WhatsApp call with accept support is available.');
            }

            await grantWhatsAppMicrophonePermission(waClient, 'call accept');
            const acceptedCall = await activeCall.accept({ injectAudio: false });
            state.activeCall = acceptedCall || state.activeCall;
            state.activeCallId = acceptedCall?.id || state.activeCallId;
            await refreshWhatsAppMicrophone('call accept');
            scheduleWhatsAppCallMicrophoneStabilization(waClient, 'call accept');
            return acceptedCall;
        } catch (error) {
            lastError = error;
            if (attempt < attempts && delayMs > 0) await sleep(delayMs);
        }
    }

    throw lastError;
}

async function pollIncomingWhatsAppCall(client) {
    if (!state.ready) {
        await refreshWhatsAppReady(client);
    }

    const activeCall = await getActiveWhatsAppCall(client);
    if (!activeCall || activeCall.fromMe) return;

    const previousCallId = state.activeCallId;
    state.activeCall = activeCall;
    state.activeCallId = activeCall.id;

    if (
        activeCall.id &&
        activeCall.id !== previousCallId &&
        !state.autoAcceptedCallIds.has(activeCall.id)
    ) {
        console.log(
            `WhatsApp incoming call detected by poller: id=${activeCall.id} from=${activeCall.from || 'unknown'} group=${activeCall.isGroup === true} video=${activeCall.isVideo === true}`,
        );
    }

    autoAcceptIncomingCall(client, activeCall);
}

async function autoAcceptIncomingCall(client, call) {
    if (!call || call.fromMe) return;

    const callId = call.id || 'unknown';
    if (
        state.autoAcceptingCallIds.has(callId) ||
        state.autoAcceptedCallIds.has(callId)
    ) {
        return;
    }

    state.autoAcceptingCallIds.add(callId);
    console.log(
        `Auto-accept scheduled: id=${callId} from=${call.from || 'unknown'} group=${call.isGroup === true} video=${call.isVideo === true}`,
    );

    setTimeout(() => {
        acceptActiveWhatsAppCall(client, call, { attempts: 6, delayMs: 500 })
            .then((acceptedCall) => {
                const resolvedCallId = acceptedCall.id || callId;
                state.autoAcceptedCallIds.add(resolvedCallId);
                console.log(`Auto-accepted incoming WhatsApp call: ${resolvedCallId}`);
            })
            .catch((error) => {
                console.error(`Auto-accept WhatsApp call failed for ${callId}: ${error.message}`);
            })
            .finally(() => {
                state.autoAcceptingCallIds.delete(callId);
            });
    }, 250);
}

module.exports = {
    getActiveWhatsAppCall,
    getActiveWhatsAppCallId,
    getLiveWhatsAppCallStatus,
    ensureWhatsAppIsMeAccountShim,
    addParticipantsToActiveCall,
    acceptActiveWhatsAppCall,
    pollIncomingWhatsAppCall,
    autoAcceptIncomingCall,
};
