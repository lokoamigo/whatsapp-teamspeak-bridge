'use strict';

// Mumble channel control for `!switchChannel` (see ../voice-channels.js). The
// command bot's own control connection moves the bridge's audio user (the
// Mumble GUI client named in MUMBLE_URI); the bot then follows it. Moving
// another user needs the Mumble "Move" permission for the bot user.

const MOVE_TIMEOUT_MS = 10000;

// Mumble ACL permission bits and PermissionDenied.DenyType values relevant to
// moving a user (Mumble.proto / ACL.h).
const PERMISSION_ENTER = 0x4;
const PERMISSION_MOVE = 0x20;
const DENY_PERMISSION = 1;
const DENY_CHANNEL_FULL = 9;

function isMoveDenial(denied) {
    if (denied.type === DENY_CHANNEL_FULL) return true;
    return (
        denied.type === DENY_PERMISSION &&
        (denied.permission === PERMISSION_MOVE || denied.permission === PERMISSION_ENTER)
    );
}

function describeMoveDenial(denied, channelName, botUsername) {
    if (denied.type === DENY_CHANNEL_FULL) {
        return `Mumble channel ${channelName} is full.`;
    }
    return (
        `The Mumble server denied moving the bridge to ${channelName}. ` +
        `Grant the bot user "${botUsername}" the Move permission (ACL) on the bridge's ` +
        'current and target channels, e.g. on the root channel for all sub-channels.'
    );
}

// Resolves once the server reports `session` in `channelId`; rejects on a move
// denial, a closed connection or after `timeoutMs`.
function waitForUserMove(mumble, session, channelId, { channelName, botUsername, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            mumble.off('userState', onUserState);
            mumble.off('permissionDenied', onPermissionDenied);
            mumble.off('closed', onClosed);
            if (error) reject(error);
            else resolve();
        };
        const onUserState = (user) => {
            if (user.session === session && user.channelId === channelId) finish();
        };
        const onPermissionDenied = (denied) => {
            if (isMoveDenial(denied)) {
                finish(new Error(describeMoveDenial(denied, channelName, botUsername)));
            }
        };
        const onClosed = (reason) => finish(new Error(reason || 'Mumble connection closed.'));
        const timer = setTimeout(
            () =>
                finish(
                    new Error(`The Mumble server did not confirm the move to ${channelName}.`),
                ),
            timeoutMs,
        );
        mumble.on('userState', onUserState);
        mumble.on('permissionDenied', onPermissionDenied);
        mumble.once('closed', onClosed);
    });
}

// getClient returns the command bot's current MumbleClient (or null).
function createMumbleChannelControl({
    getClient,
    bridgeUsername,
    botUsername,
    moveTimeoutMs = MOVE_TIMEOUT_MS,
}) {
    function requireBridgeUser() {
        const mumble = getClient();
        if (!mumble || !mumble.synced || !mumble.socket || mumble.socket.destroyed) {
            throw new Error('The Mumble command bot is not connected.');
        }
        if (!bridgeUsername) {
            throw new Error(
                'MUMBLE_URI must include the bridge username (mumble://<name>@host/...) to switch channels.',
            );
        }
        const bridgeUser = mumble.findUserByName(bridgeUsername);
        if (!bridgeUser) {
            throw new Error(`The Mumble bridge user ${bridgeUsername} is not connected.`);
        }
        return { mumble, bridgeUser };
    }

    async function listSwitchableChannels() {
        const { mumble, bridgeUser } = requireBridgeUser();
        return [...mumble.channels.values()]
            .filter((channel) => channel.id !== bridgeUser.channelId)
            .map((channel) => ({
                id: channel.id,
                name: mumble.channelName(channel.id),
                parentId: channel.parent,
            }));
    }

    async function moveToChannel(channel) {
        const { mumble, bridgeUser } = requireBridgeUser();
        if (!mumble.channels.has(channel.id)) {
            throw new Error(`Mumble channel ${channel.name} no longer exists.`);
        }
        if (bridgeUser.channelId === channel.id) return;

        const moved = waitForUserMove(mumble, bridgeUser.session, channel.id, {
            channelName: channel.name,
            botUsername,
            timeoutMs: moveTimeoutMs,
        });
        mumble.moveUserToChannel(bridgeUser.session, channel.id);
        await moved;
    }

    // Posts to the bridge user's channel; falls back to the bot's own channel
    // (they normally match, as the bot follows the bridge user).
    async function sendChannelMessage(text) {
        const mumble = getClient();
        if (!mumble || !mumble.synced || !mumble.socket || mumble.socket.destroyed) {
            throw new Error('The Mumble command bot is not connected.');
        }
        const bridgeUser = bridgeUsername ? mumble.findUserByName(bridgeUsername) : undefined;
        const channelId = bridgeUser ? bridgeUser.channelId : mumble.self && mumble.self.channelId;
        if (channelId === undefined) throw new Error('Could not determine the Mumble channel.');
        mumble.sendTextMessage({ channelIds: [channelId], text });
    }

    return { listSwitchableChannels, moveToChannel, sendChannelMessage };
}

module.exports = { createMumbleChannelControl, isMoveDenial };
