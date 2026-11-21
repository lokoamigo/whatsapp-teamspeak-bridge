'use strict';

// `!wa` chat commands over Mumble: a separate, self-deafened bot user joins the
// bridge client's channel and answers commands sent to it or to that channel.

const path = require('path');
const {
    MumbleClient,
    createTofuVerifier,
    ensureClientCertificate,
    mumbleHtmlToText,
    parseMumbleUri,
} = require('./client');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The bot connects to the server from MUMBLE_BOT_URI, else from MUMBLE_URI,
// as "<bridge user>-Bot" unless MUMBLE_BOT_URI names a user.
function getMumbleBotConfig(bridgeUri, botUri) {
    const bridge = parseMumbleUri(bridgeUri);
    const own = botUri ? parseMumbleUri(botUri) : null;
    const server = own || bridge;
    if (!server) return null;
    const bridgeUsername = bridge ? bridge.username : '';
    return {
        host: server.host,
        port: server.port,
        password: server.password,
        username: (own && own.username) || `${bridgeUsername || 'WhatsAppBridge'}-Bot`,
        channelPath: server.channelPath,
        bridgeUsername,
    };
}

function createMumbleCommandBot(options) {
    const {
        config,
        dataDir,
        release,
        commandPrefix,
        commanderIds,
        extractCommand,
        parseArgs,
        handleCommand,
        log = console,
    } = options;

    // Commander entries are Mumble certificate hashes (SHA-1 hex).
    const commanders = [...commanderIds].map((value) => String(value).trim().toLowerCase());

    function assertCommander(user) {
        if (commanders.length === 0) return;
        const hash = (user && user.hash) || '';
        if (hash && commanders.includes(hash)) return;
        throw new Error(
            hash
                ? `You are not allowed to control the WhatsApp bridge (your certificate hash: ${hash}).`
                : 'You are not allowed to control the WhatsApp bridge (connect with a Mumble certificate).',
        );
    }

    // Channel chat is shared with everyone in the channel, so only prefixed
    // commands count there; private messages also accept bare commands.
    function extractMumbleCommand(text, isPrivate) {
        if (isPrivate) return extractCommand(text);
        const trimmed = String(text || '').trim();
        if (trimmed === commandPrefix) return '';
        if (trimmed.startsWith(commandPrefix) && /\s/.test(trimmed[commandPrefix.length])) {
            return trimmed.slice(commandPrefix.length).trim();
        }
        return null;
    }

    async function onTextMessage(mumble, event) {
        const text = mumbleHtmlToText(event.message);
        const commandText = extractMumbleCommand(text, event.sessions.includes(mumble.session));
        if (!commandText) return;

        const user = event.user;
        log.log(`Mumble command from ${user ? user.name : `session ${event.actor}`}: ${text}`);

        let response;
        try {
            assertCommander(user);
            response = await handleCommand(parseArgs(commandText));
        } catch (error) {
            response = `Error: ${error.message}`;
        }
        if (event.actor !== undefined && mumble.users.has(event.actor)) {
            mumble.sendTextMessage({ sessions: [event.actor], text: response });
        }
    }

    // Keeps the bot in the bridge client's channel (or the URI channel path)
    // so channel chat commands reach it.
    function followBridgeChannel(mumble, tracking) {
        const self = mumble.self;
        if (!mumble.synced || !self) return;
        const bridgeUser = config.bridgeUsername
            ? mumble.findUserByName(config.bridgeUsername)
            : undefined;
        const target = bridgeUser ? bridgeUser.channelId : mumble.findChannelByPath(config.channelPath);
        if (target === undefined || target === self.channelId || target === tracking.requestedChannelId) {
            return;
        }
        tracking.requestedChannelId = target;
        log.log(
            `Mumble command bot joining channel ${mumble.channelName(target)}` +
                `${bridgeUser ? ` (following ${bridgeUser.name})` : ''}.`,
        );
        mumble.moveToChannel(target);
    }

    let identity = null;
    let stopped = false;
    let current = null;

    async function connectOnce() {
        const mumble = new MumbleClient({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            cert: identity && identity.cert,
            key: identity && identity.key,
            verifyServer: createTofuVerifier(path.join(dataDir, 'known-servers.json')),
            release,
        });
        current = mumble;
        const tracking = { requestedChannelId: undefined };
        const follow = () => followBridgeChannel(mumble, tracking);

        mumble.on('serverPinned', (fingerprint) => {
            log.log(`Trusting Mumble server ${config.host}:${config.port} (sha256 ${fingerprint}).`);
        });
        mumble.on('userState', (user, change) => {
            // Clear the pending move once it arrived, so a later move away from
            // the bridge channel (e.g. by an admin) is corrected again.
            if (
                user.session === mumble.session &&
                change.movedChannel &&
                user.channelId === tracking.requestedChannelId
            ) {
                tracking.requestedChannelId = undefined;
            }
            follow();
        });
        mumble.on('userRemoved', follow);
        mumble.on('channelsChanged', follow);
        mumble.on('permissionDenied', (denied) => {
            log.error(`Mumble command bot: permission denied${denied.reason ? ` (${denied.reason})` : ''}.`);
        });
        mumble.on('protocolError', (error) => {
            log.error(`Mumble command bot protocol error: ${error.message}`);
        });
        mumble.on('textMessage', (event) => {
            onTextMessage(mumble, event).catch((error) => {
                log.error(`Mumble command failed: ${error.message}`);
            });
        });

        await mumble.connect();
        log.log(`Mumble command bot connected to ${config.host}:${config.port} as ${config.username}.`);
        mumble.setSelfMuteDeaf(true, true);
        follow();
        return mumble;
    }

    async function run() {
        try {
            identity = await ensureClientCertificate(dataDir, config.username);
        } catch (error) {
            log.error(`Mumble bot certificate unavailable (${error.message}); connecting without one.`);
        }

        let retryDelayMs = 5000;
        while (!stopped) {
            try {
                const mumble = await connectOnce();
                retryDelayMs = 5000;
                const reason = await mumble.closed;
                if (stopped) break;
                log.error(`Mumble command bot disconnected (${reason}); reconnecting.`);
            } catch (error) {
                if (stopped) break;
                log.error(`Mumble command bot not connected: ${error.message}`);
            }
            await sleep(retryDelayMs);
            retryDelayMs = Math.min(retryDelayMs * 2, 60000);
        }
    }

    function stop() {
        stopped = true;
        if (current) current.close('Stopped.');
    }

    return { run, stop, get client() { return current; } };
}

module.exports = { createMumbleCommandBot, getMumbleBotConfig };
