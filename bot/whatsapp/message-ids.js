'use strict';

// Helpers that read IDs and options from whatsapp-web.js message/vote objects,
// whose shapes vary between WhatsApp Web runtimes.

function getMessageIdAliases(message) {
    return Array.from(
        new Set(
            [
                message?.id?._serialized,
                message?.id?.id,
                typeof message?.id === 'string' ? message.id : null,
            ].filter(Boolean),
        ),
    );
}

function getMessageSenderId(message) {
    return message.author || message.from || null;
}

function getMessageChatId(message) {
    return message.fromMe ? message.to || message.from : message.from;
}

function getVotePollIdAliases(vote) {
    return Array.from(
        new Set(
            [
                vote?.parentMsgKey?._serialized,
                vote?.parentMsgKey?.id,
                typeof vote?.parentMsgKey === 'string' ? vote.parentMsgKey : null,
                vote?.parentMessage?.id?._serialized,
                vote?.parentMessage?.id?.id,
                typeof vote?.parentMessage?.id === 'string'
                    ? vote.parentMessage.id
                    : null,
            ].filter(Boolean),
        ),
    );
}

function getPollOptionNames(message) {
    return (message?.pollOptions || [])
        .map((option) => option.name)
        .filter((name) => typeof name === 'string');
}

module.exports = {
    getMessageIdAliases,
    getMessageSenderId,
    getMessageChatId,
    getVotePollIdAliases,
    getPollOptionNames,
};
