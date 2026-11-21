'use strict';

// Incoming WhatsApp text commands: `!invite` and `!switchChannel`.

const { WHATSAPP_INVITE_COMMAND } = require('../config');
const { normalizeContactId } = require('../contacts');
const { getActiveWhatsAppCallId } = require('./calls');
const {
    parseWhatsAppSwitchChannelCommand,
    handleWhatsAppSwitchChannelCommand,
} = require('./channel-polls');

async function resolveMessageSenderContactId(message) {
    const senderId = message.author || message.from;
    if (!senderId || senderId.endsWith('@g.us')) return null;
    if (senderId.endsWith('@c.us')) return senderId;

    if (typeof message.getContact !== 'function') return null;

    const contact = await message.getContact();
    if (contact?.id?._serialized?.endsWith('@c.us')) {
        return contact.id._serialized;
    }
    if (contact?.number) {
        return normalizeContactId(contact.number);
    }

    return null;
}

async function handleWhatsAppMessage(client, message) {
    if (message.fromMe) return;

    const body = String(message.body || '').trim();
    const switchCommand = parseWhatsAppSwitchChannelCommand(body);
    if (switchCommand) {
        await handleWhatsAppSwitchChannelCommand(client, message, switchCommand);
        return;
    }

    if (body.toLowerCase() !== WHATSAPP_INVITE_COMMAND.toLowerCase()) return;

    const activeCallId = await getActiveWhatsAppCallId(client);
    if (!activeCallId) {
        console.log('Ignoring WhatsApp invite command: no active call.');
        return;
    }

    const contactId = await resolveMessageSenderContactId(message);
    if (!contactId) {
        console.error('Ignoring WhatsApp invite command: sender is not an individual contact.');
        return;
    }

    await client.addParticipantToCall(contactId, activeCallId);
    console.log(
        `Invited WhatsApp message sender ${contactId} to active call: ${activeCallId}`,
    );
}

module.exports = { handleWhatsAppMessage, resolveMessageSenderContactId };
