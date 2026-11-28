'use strict';

// Relays channel chat between the bridge's TeamSpeak and Mumble rooms in
// combined mode. Only channel messages are relayed (never private or server
// chat) and never `!wa` commands. The bridge's own accounts are ignored by the
// listeners, so relayed text and call announcements cannot echo back.
//
// Delivery is best-effort: one serial queue per direction with a small cap, so
// a chat flood is dropped instead of tripping TeamSpeak's anti-flood (which
// would kick the voice client) or the Mumble server's rate limit.

const state = require('./state');
const { mumbleHtmlToText } = require('./mumble/client');

const MAX_QUEUED = 8;
const MAX_BYTES = 900; // TeamSpeak caps a text message near 1024 bytes.
const ERROR_LOG_INTERVAL_MS = 60000;

const TARGET_LABELS = { teamspeak: 'TS', mumble: 'Mumble' };

function truncateBytes(text, limit) {
    if (Buffer.byteLength(text) <= limit) return text;
    let end = text.length;
    while (end > 0 && Buffer.byteLength(text.slice(0, end)) > limit - 3) end -= 1;
    // Never split a surrogate pair.
    if (end > 0 && /[\ud800-\udbff]/.test(text[end - 1])) end -= 1;
    return `${text.slice(0, end)}...`;
}

// TeamSpeak chat uses BBCode; clients wrap pasted links as [URL]...[/URL].
function stripTeamSpeakBbcode(text) {
    return String(text || '')
        .replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, (_, href, label) => (label === href ? label : `${label} (${href})`))
        .replace(/\[\/?(?:url|img|b|i|u|s|color|size|center|left|right|list|code|quote|sub|sup|table|tr|td|th|\*)(?:=[^\]]*)?\]/gi, '');
}

function normalize(text) {
    return String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function createChatRelay({
    commandPrefix,
    getSender = (target) => state.voiceChannels[target],
    log = console,
    now = Date.now,
} = {}) {
    const queues = { teamspeak: { tail: Promise.resolve(), pending: 0 }, mumble: { tail: Promise.resolve(), pending: 0 } };
    let lastErrorAt = -Infinity;

    const logError = (message) => {
        if (now() - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
        lastErrorAt = now();
        log.error(message);
    };

    function isCommand(text) {
        return text.startsWith(commandPrefix) && (text.length === commandPrefix.length || /\s/.test(text[commandPrefix.length]));
    }

    function deliver(target, line) {
        const queue = queues[target];
        if (queue.pending >= MAX_QUEUED) {
            logError(`Chat relay to ${TARGET_LABELS[target]} is backed up; dropping messages.`);
            return;
        }
        queue.pending += 1;
        queue.tail = queue.tail
            .then(() => {
                const sender = getSender(target);
                if (!sender) throw new Error(`${TARGET_LABELS[target]} channel control is not available`);
                return sender.sendChannelMessage(line);
            })
            .catch((error) => logError(`Chat relay to ${TARGET_LABELS[target]} failed: ${error.message}`))
            .finally(() => { queue.pending -= 1; });
    }

    // `text` is plain text; the caller decides what counts as a channel message.
    function relay(source, name, text) {
        try {
            const target = source === 'teamspeak' ? 'mumble' : 'teamspeak';
            const body = normalize(text);
            if (!body || isCommand(body)) return;
            const sender = normalize(name) || 'unknown';
            deliver(target, truncateBytes(`[${TARGET_LABELS[source]}] ${sender}: ${body}`, MAX_BYTES));
        } catch (error) {
            logError(`Chat relay failed: ${error.message}`);
        }
    }

    // ClientQuery notifytextmessage: targetmode 2 is the channel chat.
    function fromTeamSpeak(event, { ownClientId } = {}) {
        if (String(event.targetmode) !== '2') return;
        // Without a known own ID the bridge's own relayed messages are indistinguishable.
        if (!ownClientId || event.invokerid === ownClientId) return;
        relay('teamspeak', event.invokername, stripTeamSpeakBbcode(event.msg));
    }

    // Native Mumble `text` event; the helper already drops own and server text.
    function fromMumble(event) {
        if (event.private) return;
        relay('mumble', event.user && event.user.name, mumbleHtmlToText(event.message));
    }

    // Posts a bridge-originated notice (presence etc.) through the same
    // rate-limited queues as relayed chat.
    function announce(target, line) {
        try {
            deliver(target, truncateBytes(normalize(line), MAX_BYTES));
        } catch (error) {
            logError(`Chat relay failed: ${error.message}`);
        }
    }

    return { fromTeamSpeak, fromMumble, relay, announce };
}

module.exports = { createChatRelay, normalize, stripTeamSpeakBbcode, truncateBytes };
