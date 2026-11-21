'use strict';

// `!wa ...` command set shared by the TeamSpeak and Mumble chat listeners.

const { COMMAND_PREFIX, COMMANDER_UIDS } = require('./config');
const state = require('./state');
const { parseArgs } = require('./util');
const {
    contactGroupsText,
    normalizeContactId,
    resolveCallTargets,
} = require('./contacts');
const { refreshWhatsAppMicrophone } = require('./audio/pulse');
const {
    acceptActiveWhatsAppCall,
    addParticipantsToActiveCall,
    ensureWhatsAppIsMeAccountShim,
    getActiveWhatsAppCall,
    getActiveWhatsAppCallId,
} = require('./whatsapp/calls');
const {
    grantWhatsAppMicrophonePermission,
    scheduleWhatsAppCallMicrophoneStabilization,
} = require('./whatsapp/microphone');
const {
    refreshWhatsAppReady,
    whatsappStatusText,
} = require('./whatsapp/readiness');

const BARE_COMMANDS = new Set([
    'help',
    'status',
    'add',
    'accept',
    'answer',
    'call',
    'callgroup',
    'groupcall',
    'hangup',
    'end',
]);

function extractCommand(message) {
    const trimmed = String(message || '').trim();
    if (!trimmed) return null;

    if (trimmed.startsWith(COMMAND_PREFIX)) {
        return trimmed.slice(COMMAND_PREFIX.length).trim();
    }

    const [command] = parseArgs(trimmed);
    if (command && BARE_COMMANDS.has(command.toLowerCase())) {
        return trimmed;
    }

    return null;
}

function assertCommander(event) {
    if (COMMANDER_UIDS.size === 0) return;
    if (!COMMANDER_UIDS.has(event.invokeruid)) {
        throw new Error('You are not allowed to control the WhatsApp bridge.');
    }
}

async function handleCommand(waClient, args) {
    const command = (args.shift() || 'help').toLowerCase();

    if (command === 'help') {
        return [
            `${COMMAND_PREFIX} add +491701234567 [more numbers]`,
            `${COMMAND_PREFIX} accept`,
            `${COMMAND_PREFIX} call +491701234567`,
            `${COMMAND_PREFIX} call +491701234567 +491761234567 [more]`,
            `${COMMAND_PREFIX} call <contact-group-name>`,
            `${COMMAND_PREFIX} callgroup <contact-group-name>`,
            `${COMMAND_PREFIX} hangup`,
            `${COMMAND_PREFIX} status`,
            `contactGroups=${contactGroupsText()}`,
        ].join('\n');
    }

    if (command === 'status') {
        await refreshWhatsAppReady(waClient).catch((error) => {
            state.whatsapp = { ready: false, reason: error.message };
        });
        return `WhatsApp ${whatsappStatusText()} activeCall=${state.activeCallId || 'unknown'}`;
    }

    if (command === 'add') {
        if (args.length === 0) {
            throw new Error(`Usage: ${COMMAND_PREFIX} add +491701234567 [more numbers]`);
        }

        const contactIds = args.map(normalizeContactId);
        const activeCallId = await addParticipantsToActiveCall(waClient, contactIds);
        return `Invited ${contactIds.length} participant(s) to WhatsApp call: ${activeCallId}`;
    }

    if (command === 'accept' || command === 'answer') {
        const acceptedCall = await acceptActiveWhatsAppCall(waClient);
        return `Accepted WhatsApp call: ${acceptedCall.id || 'active call'}`;
    }

    if (command === 'call') {
        if (args.length < 1) {
            throw new Error(`Usage: ${COMMAND_PREFIX} call +491701234567 [more numbers]`);
        }

        const contactIds = resolveCallTargets(args);
        const activeCallId = await getActiveWhatsAppCallId(waClient);
        if (activeCallId) {
            await addParticipantsToActiveCall(waClient, contactIds);
            return `Active WhatsApp call detected; invited ${contactIds.length} participant(s) instead: ${activeCallId}`;
        }

        await grantWhatsAppMicrophonePermission(waClient, 'call start');
        await ensureWhatsAppIsMeAccountShim(waClient);
        const call =
            contactIds.length === 1
                ? await waClient.call(contactIds[0], {
                      video: false,
                      injectAudio: false,
                  })
                : await waClient.startGroupCall(contactIds, { video: false });
        state.activeCall = call;
        state.activeCallId = call.id;
        await refreshWhatsAppMicrophone('call start');
        scheduleWhatsAppCallMicrophoneStabilization(waClient, 'call start');
        return `Started WhatsApp voice call with ${contactIds.length} participant(s): ${call.id}`;
    }

    if (command === 'groupcall' || command === 'callgroup') {
        if (args.length < 1) {
            throw new Error(
                `Usage: ${COMMAND_PREFIX} callgroup <contact-group-name>`,
            );
        }

        const contactIds = resolveCallTargets(args);
        if (contactIds.length < 2) {
            throw new Error('A WhatsApp group call needs at least two individual participants.');
        }
        await grantWhatsAppMicrophonePermission(waClient, 'group call start');
        await ensureWhatsAppIsMeAccountShim(waClient);
        const call = await waClient.startGroupCall(contactIds, { video: false });
        state.activeCall = call;
        state.activeCallId = call.id;
        await refreshWhatsAppMicrophone('group call start');
        scheduleWhatsAppCallMicrophoneStabilization(waClient, 'group call start');
        return `Started WhatsApp group voice call with ${contactIds.length} participant(s): ${call.id}`;
    }

    if (command === 'hangup' || command === 'end') {
        const activeCall =
            state.activeCall && typeof state.activeCall.end === 'function'
                ? state.activeCall
                : await getActiveWhatsAppCall(waClient);
        if (!activeCall || typeof activeCall.end !== 'function') {
            throw new Error('No active WhatsApp call with end support is available.');
        }

        await activeCall.end();
        state.activeCall = null;
        state.activeCallId = null;
        state.micStabilizationRunId += 1;
        return 'Ended the current WhatsApp call.';
    }

    throw new Error(`Unknown command. Try: ${COMMAND_PREFIX} help`);
}

module.exports = { BARE_COMMANDS, extractCommand, assertCommander, handleCommand };
