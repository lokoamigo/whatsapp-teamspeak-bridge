'use strict';

// Lets people in the bridge's TeamSpeak and Mumble rooms know about each
// other (combined mode). Every few seconds each side's channel roster is
// polled and diffed:
//   - arrivals/departures are announced in the other room's chat, and
//   - an arrival is told privately who is in the other room.
// Polling instead of events keeps this self-healing: the first poll after a
// reconnect, or after the bridge changed channel, only sets a silent baseline.
//
// A side is { label, poll(), sendPrivate(user, text) } where poll() resolves to
// { channel, users: [{ key, name, ... }] } (the bridge itself excluded).

const { startSerialInterval } = require('./util');
const { normalize } = require('./chat-relay');

const POLL_MS = 3000;
const MAX_NAMES = 6;
// Private messages bypass the chat queue, so cap them to spare anti-flood limits.
const MAX_ROSTERS_PER_POLL = 5;

function formatNames(users) {
    const names = users.map((user) => normalize(user.name) || 'unknown');
    if (names.length <= MAX_NAMES) return names.join(', ');
    return `${names.slice(0, MAX_NAMES).join(', ')} and ${names.length - MAX_NAMES} more`;
}

function describeRoster(label, users) {
    if (!users.length) return `Nobody is in the ${label} channel right now.`;
    return `In the ${label} channel: ${formatNames(users)}.`;
}

function createPresence({ sides, announce, log = console, pollMs = POLL_MS } = {}) {
    // snapshot: { channel, users: Map<key, user> } or null while unknown.
    const snapshots = { teamspeak: null, mumble: null };
    const others = { teamspeak: 'mumble', mumble: 'teamspeak' };

    async function poll(name) {
        const side = sides[name];
        let result;
        try {
            result = await side.poll();
        } catch (_) {
            snapshots[name] = null; // not connected: resync silently later
            return;
        }
        const next = { channel: result.channel, users: new Map(result.users.map((user) => [user.key, user])) };
        const prev = snapshots[name];
        snapshots[name] = next;
        if (!prev || prev.channel !== next.channel) return;

        const joined = [...next.users.values()].filter((user) => !prev.users.has(user.key));
        const left = [...prev.users.values()].filter((user) => !next.users.has(user.key));
        const other = others[name];
        if (left.length) announce(other, `[${side.label}] left: ${formatNames(left)}`);
        if (joined.length) {
            announce(other, `[${side.label}] joined: ${formatNames(joined)}`);
            const otherSnapshot = snapshots[other];
            if (otherSnapshot) {
                const text = describeRoster(sides[other].label, [...otherSnapshot.users.values()]);
                // One at a time; a hanging side only delays its own next poll.
                for (const user of joined.slice(0, MAX_ROSTERS_PER_POLL)) {
                    try {
                        await side.sendPrivate(user, text);
                    } catch (error) {
                        log.error(`Presence roster for ${side.label} user failed: ${error.message}`);
                    }
                }
            }
        }
    }

    function start() {
        const onError = (error) => log.error(`Presence poll failed: ${error.message}`);
        const timers = Object.keys(sides).map((name) => startSerialInterval(() => poll(name), pollMs, onError));
        return () => timers.forEach(clearInterval);
    }

    return { poll, start, snapshots };
}

module.exports = { createPresence, describeRoster, formatNames };
