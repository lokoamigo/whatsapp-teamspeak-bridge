'use strict';

// `!switchChannel` from WhatsApp: direct switches and paged WhatsApp polls
// listing voice channels (TeamSpeak or Mumble), plus resolving poll votes
// back to a channel.

const { Poll } = require('whatsapp-web.js');
const {
    CHANNEL_POLL_MAX_OPTIONS,
    SHOW_MORE_CHANNELS_OPTION,
    WHATSAPP_SWITCH_CHANNEL_COMMAND,
    WHATSAPP_SWITCH_CHANNEL_COMMAND_TYPO,
    VOICE_BACKEND_LABEL,
} = require('../config');
const state = require('../state');
const { RecentSet } = require('../recent-set');
const {
    getMessageIdAliases,
    getMessageSenderId,
    getMessageChatId,
    getVotePollIdAliases,
    getPollOptionNames,
} = require('./message-ids');
const { requireVoiceChannels, switchToChannelByName } = require('../voice-channels');

const CHANNEL_POLL_TITLE = `Switch ${VOICE_BACKEND_LABEL} channel`;
const CHANNEL_POLL_TTL_MS = 30 * 60 * 1000;
const MAX_CHANNEL_POLLS = 100;
let cleanupTimer = null;

function startChannelPollCleanup() {
    if (!cleanupTimer) {
        cleanupTimer = setInterval(pruneChannelPolls, 60000);
        cleanupTimer.unref();
    }
}

function parseWhatsAppSwitchChannelCommand(body) {
    const trimmed = String(body || '').trim();
    const lower = trimmed.toLowerCase();
    for (const command of [
        WHATSAPP_SWITCH_CHANNEL_COMMAND,
        WHATSAPP_SWITCH_CHANNEL_COMMAND_TYPO,
    ]) {
        if (lower === command) return { channelName: '' };
        if (lower.startsWith(`${command} `)) {
            return { channelName: trimmed.slice(command.length).trim() };
        }
    }
    return null;
}

function channelPollOptionName(channel, duplicateNames) {
    if (!duplicateNames.has(channel.name.toLowerCase())) return channel.name;
    return `${channel.name} [cid ${channel.id}]`;
}

function getDuplicateChannelNames(channels) {
    const counts = new Map();
    for (const channel of channels) {
        const normalized = channel.name.toLowerCase();
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
    return new Set(
        Array.from(counts.entries())
            .filter(([, count]) => count > 1)
            .map(([name]) => name),
    );
}

function buildChannelPollState(chatId, requestedBy, page, pageChannels, hasMore, options) {
    return {
        chatId,
        requestedBy,
        page,
        channels: pageChannels,
        hasMore,
        options,
        createdAt: Date.now(),
    };
}

function registerChannelPollIds(pollIds, pollState) {
    const ids = Array.from(new Set((pollIds || []).filter(Boolean)));
    if (ids.length === 0) return false;
    pollState.pollIds = Array.from(
        new Set([...(pollState.pollIds || []), ...ids]),
    );
    for (const pollId of ids) {
        state.channelPolls.set(pollId, pollState);
    }
    pruneChannelPolls();
    console.log(
        `Tracking ${VOICE_BACKEND_LABEL} channel poll ${ids.join(',')} for chat=${pollState.chatId} page=${pollState.page}`,
    );
    return true;
}

function queuePendingChannelPoll(pollState) {
    state.pendingChannelPolls.push(pollState);
    pruneChannelPolls();
    console.log(
        `Waiting for outgoing ${VOICE_BACKEND_LABEL} channel poll ID for chat=${pollState.chatId} page=${pollState.page}`,
    );
}

function clearActiveChannelPollsForChat(chatId) {
    for (const pollState of getTrackedChannelPollStates()) {
        if (pollState.chatId !== chatId || pollState.completed) continue;
        pollState.completed = true;
        deleteChannelPollState(pollState);
    }
    state.pendingChannelPolls = state.pendingChannelPolls.filter((pollState) => {
        return pollState.chatId !== chatId || pollState.completed;
    });
}

function removePendingChannelPoll(pollState) {
    const index = state.pendingChannelPolls.indexOf(pollState);
    if (index !== -1) state.pendingChannelPolls.splice(index, 1);
}

function deleteChannelPollState(pollState) {
    for (const pollId of pollState.pollIds || []) {
        state.channelPolls.delete(pollId);
    }
}

function getTrackedChannelPollStates() {
    return Array.from(new Set(state.channelPolls.values()));
}

function optionListsMatch(left, right) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function pruneChannelPolls() {
    const expiresBefore = Date.now() - CHANNEL_POLL_TTL_MS;
    for (const [pollId, pollState] of state.channelPolls.entries()) {
        if (pollState.createdAt < expiresBefore) {
            state.channelPolls.delete(pollId);
        }
    }
    state.pendingChannelPolls = state.pendingChannelPolls.filter(
        (pollState) => pollState.createdAt >= expiresBefore,
    );
    const tracked = [...new Set([
        ...state.channelPolls.values(), ...state.pendingChannelPolls,
    ])].sort((left, right) => left.createdAt - right.createdAt);
    for (const pollState of tracked.slice(0, Math.max(0, tracked.length - MAX_CHANNEL_POLLS))) {
        deleteChannelPollState(pollState);
        removePendingChannelPoll(pollState);
    }
}

// Outgoing poll messages sometimes only receive their ID via message_create;
// match them to the pending poll by chat and option list.
function handleWhatsAppMessageCreate(message) {
    if (!message.fromMe || state.pendingChannelPolls.length === 0) return;
    if (message.pollName && message.pollName !== CHANNEL_POLL_TITLE) return;

    const pollIds = getMessageIdAliases(message);
    const pollId = pollIds[0] || null;
    if (!pollId) {
        console.error(`Outgoing ${VOICE_BACKEND_LABEL} channel poll still has no message ID.`);
        return;
    }

    const chatId = getMessageChatId(message);
    const options = getPollOptionNames(message);
    let pendingIndex = state.pendingChannelPolls.findIndex((pollState) => {
        return pollState.chatId === chatId && optionListsMatch(pollState.options, options);
    });
    if (pendingIndex === -1 && options.length === 0) {
        const chatPending = state.pendingChannelPolls
            .map((pollState, index) => ({ pollState, index }))
            .filter(({ pollState }) => pollState.chatId === chatId);
        if (chatPending.length === 1) pendingIndex = chatPending[0].index;
    }
    if (pendingIndex === -1) return;

    const [pollState] = state.pendingChannelPolls.splice(pendingIndex, 1);
    registerChannelPollIds(pollIds, pollState);
}

async function sendChannelSwitchPoll(client, chatId, requestedBy, page = 0) {
    if (typeof Poll !== 'function') {
        throw new Error('The configured whatsapp-web.js build does not expose Poll support.');
    }

    const voiceChannels = requireVoiceChannels();
    const channels = await voiceChannels.listSwitchableChannels();
    if (channels.length === 0) {
        await client.sendMessage(chatId, `No other ${VOICE_BACKEND_LABEL} channels are available.`);
        return;
    }

    const channelSlots = CHANNEL_POLL_MAX_OPTIONS - 1;
    const start = page * channelSlots;
    const pageChannels = channels.slice(start, start + channelSlots);
    if (pageChannels.length === 0) {
        await client.sendMessage(chatId, `No more ${VOICE_BACKEND_LABEL} channels are available.`);
        return;
    }

    const hasMore = start + pageChannels.length < channels.length;
    const duplicateNames = getDuplicateChannelNames(channels);
    const options = pageChannels.map((channel) =>
        channelPollOptionName(channel, duplicateNames),
    );
    if (hasMore) options.push(SHOW_MORE_CHANNELS_OPTION);

    const poll = new Poll(CHANNEL_POLL_TITLE, options, {
        allowMultipleAnswers: false,
    });
    if (page === 0) clearActiveChannelPollsForChat(chatId);
    const pollState = buildChannelPollState(
        chatId,
        requestedBy,
        page,
        pageChannels,
        hasMore,
        options,
    );
    queuePendingChannelPoll(pollState);
    const sentMessage = await client.sendMessage(chatId, poll);
    const pollIds = getMessageIdAliases(sentMessage);
    if (registerChannelPollIds(pollIds, pollState)) {
        removePendingChannelPoll(pollState);
        return;
    }
}

async function handleWhatsAppSwitchChannelCommand(client, message, command) {
    const chatId = message.from;
    const requestedBy = getMessageSenderId(message);
    console.log(
        `WhatsApp switch channel command from=${requestedBy || 'unknown'} chat=${chatId} arg=${command.channelName || '<poll>'}`,
    );

    if (command.channelName) {
        try {
            const channel = await switchToChannelByName(command.channelName);
            await message.reply(`Switched ${VOICE_BACKEND_LABEL} channel to: ${channel.name}`);
        } catch (error) {
            await message.reply(`Error: ${error.message}`);
        }
        return;
    }

    try {
        await sendChannelSwitchPoll(client, chatId, requestedBy, 0);
    } catch (error) {
        await message.reply(`Error: ${error.message}`);
    }
}

async function handleWhatsAppPollVote(client, vote) {
    const pollIds = getVotePollIdAliases(vote);
    const pollId = pollIds[0] || null;
    const pollState = pollIds
        .map((id) => state.channelPolls.get(id))
        .find(Boolean);
    console.log(
        `WhatsApp poll vote received: pollIds=${pollIds.join(',') || 'unknown'} voter=${vote.voter || 'unknown'} selected=${(vote.selectedOptions || []).map((option) => `${option.localId ?? option.id}:${option.name || ''}`).join(',') || 'none'}`,
    );
    if (!pollState) {
        console.log(
            `Ignoring WhatsApp poll vote: no tracked ${VOICE_BACKEND_LABEL} channel poll for ${pollId || 'unknown'}`,
        );
        return;
    }

    await processChannelPollSelection(client, pollState, vote.selectedOptions?.[0], {
        source: 'vote_update',
        voter: vote.voter,
    });
}

// Votes reported by the in-page bulkUpsert hook (see poll-vote-hook.js).
async function handleWhatsAppPollVoteBulkUpsert(client, event) {
    const parentKeys = Array.isArray(event?.parentKeys) ? event.parentKeys : [];
    const chatIds = Array.isArray(event?.chatIds) ? event.chatIds : [];
    const selectedIds =
        event?.selectedOptionLocalIds?.length > 0
            ? event.selectedOptionLocalIds
            : event?.lastSuccessfulSelectedOptionLocalIds || [];
    if (selectedIds.length === 0) {
        console.log('Ignoring WhatsApp poll bulk-upsert: no selected option IDs.');
        return;
    }

    let pollState = parentKeys
        .map((key) => state.channelPolls.get(key))
        .find(Boolean);
    if (!pollState) {
        const activeStates = getTrackedChannelPollStates().filter((candidate) => {
            return (
                !candidate.completed &&
                Date.now() - candidate.createdAt < CHANNEL_POLL_TTL_MS &&
                chatIds.includes(candidate.chatId)
            );
        });
        if (activeStates.length === 1) {
            pollState = activeStates[0];
        }
    }
    if (!pollState) {
        console.log(
            `Ignoring WhatsApp poll bulk-upsert: no tracked poll for parentKeys=${parentKeys.join(',') || 'none'} chatIds=${chatIds.join(',') || 'none'}`,
        );
        return;
    }

    const localId = Number(selectedIds[0]);
    if (!Number.isInteger(localId)) {
        console.log(
            `Ignoring WhatsApp poll bulk-upsert: selected option is not numeric (${selectedIds[0]}).`,
        );
        return;
    }

    const voteKey = `${event.voter || 'unknown'}:${parentKeys.join(',')}:${selectedIds.join(',')}`;
    if (!pollState.seenVoteKeys) pollState.seenVoteKeys = new RecentSet(256);
    if (pollState.seenVoteKeys.has(voteKey)) return;
    pollState.seenVoteKeys.add(voteKey);

    console.log(
        `Processing WhatsApp poll bulk-upsert vote: voter=${event.voter || 'unknown'} selected=${selectedIds.join(',')} parentKeys=${parentKeys.join(',') || 'none'}`,
    );
    await processChannelPollSelection(
        client,
        pollState,
        {
            localId,
            name: pollState.options[localId],
        },
        {
            source: 'bulk_upsert',
            voter: event.voter,
        },
    );
}

async function processChannelPollSelection(client, pollState, selected, context) {
    const voter = context?.voter || null;
    const source = context?.source || 'unknown';

    if (pollState.requestedBy && voter && pollState.requestedBy !== voter) {
        console.log(
            `Accepting WhatsApp poll ${source} from voter ${voter}; requester was ${pollState.requestedBy}`,
        );
    }

    if (!selected) {
        console.log(`Ignoring WhatsApp poll ${source}: no selected option.`);
        return;
    }

    const localId = selected.localId ?? selected.id;
    const optionIndex = Number.isInteger(localId)
        ? localId
        : pollState.options.indexOf(selected.name);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) {
        console.log(`Ignoring WhatsApp poll ${source}: selected option cannot be resolved.`);
        return;
    }

    pollState.completed = true;
    if (pollState.hasMore && optionIndex === pollState.channels.length) {
        deleteChannelPollState(pollState);
        await sendChannelSwitchPoll(
            client,
            pollState.chatId,
            pollState.requestedBy,
            pollState.page + 1,
        );
        return;
    }

    const channel = pollState.channels[optionIndex];
    if (!channel) {
        console.log(`Ignoring WhatsApp poll ${source}: no channel at option index ${optionIndex}.`);
        pollState.completed = false;
        return;
    }

    deleteChannelPollState(pollState);
    const voiceChannels = requireVoiceChannels();
    console.log(`Switching ${VOICE_BACKEND_LABEL} channel by WhatsApp poll ${source} to ${channel.name} (${channel.id}).`);
    try {
        await voiceChannels.moveToChannel(channel);
    } catch (error) {
        pollState.completed = false;
        console.error(
            `Could not switch ${VOICE_BACKEND_LABEL} channel to ${channel.name} (${channel.id}): ${error.message}`,
        );
        await client.sendMessage(
            pollState.chatId,
            `Error switching ${VOICE_BACKEND_LABEL} channel: ${error.message}`,
        );
        return;
    }
    await client.sendMessage(
        pollState.chatId,
        `Switched ${VOICE_BACKEND_LABEL} channel to: ${channel.name}`,
    );
}

module.exports = {
    startChannelPollCleanup,
    parseWhatsAppSwitchChannelCommand,
    handleWhatsAppSwitchChannelCommand,
    handleWhatsAppMessageCreate,
    handleWhatsAppPollVote,
    handleWhatsAppPollVoteBulkUpsert,
};
