'use strict';

const http = require('http');
const net = require('net');
const { Client, ClientInfo, NoAuth, Poll } = require('whatsapp-web.js');

const TS_HOST = process.env.TS3_CLIENTQUERY_HOST || '127.0.0.1';
const TS_PORT = Number.parseInt(process.env.TS3_CLIENTQUERY_PORT || '25639', 10);
const TS_API_KEY = (process.env.TS3_CLIENTQUERY_API_KEY || '').trim();
const TS3_URI = process.env.TS3_URI || '';
const CHROMIUM_EXECUTABLE =
    process.env.WWEBJS_CHROMIUM_EXECUTABLE || '/usr/bin/chromium';
const CHROMIUM_PROFILE = process.env.WWEBJS_CHROMIUM_PROFILE || '/data/chromium';
const COMMAND_PREFIX = process.env.BRIDGE_COMMAND_PREFIX || '!wa';
const WHATSAPP_INVITE_COMMAND =
    process.env.BRIDGE_WHATSAPP_INVITE_COMMAND || '!invite';
const API_HOST = process.env.BRIDGE_API_HOST || '0.0.0.0';
const API_PORT = Math.max(
    1,
    Number.parseInt(process.env.BRIDGE_API_PORT || '8080', 10) || 8080,
);
const WHATSAPP_SWITCH_CHANNEL_COMMAND = '!switchchannel';
const WHATSAPP_SWITCH_CHANNEL_COMMAND_TYPO = '!switchcahnnel';
const CHANNEL_POLL_MAX_OPTIONS = Math.min(
    12,
    Math.max(
        2,
        Number.parseInt(
            process.env.BRIDGE_WHATSAPP_CHANNEL_POLL_MAX_OPTIONS || '12',
            10,
        ) || 12,
    ),
);
const SHOW_MORE_CHANNELS_OPTION = 'show more channels';
const AUTO_ACCEPT_POLL_MS = Math.max(
    1000,
    Number.parseInt(process.env.BRIDGE_AUTO_ACCEPT_POLL_MS || '5000', 10) ||
        5000,
);
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
const COMMANDER_UIDS = new Set(
    (process.env.BRIDGE_COMMANDER_UIDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
);
const CONTACT_GROUPS = parseContactGroups(process.env.BRIDGE_CONTACT_GROUPS || '{}');

const state = {
    ready: false,
    whatsapp: null,
    recoveredEventListenersAttached: false,
    activeCallId: null,
    activeCall: null,
    autoAcceptingCallIds: new Set(),
    autoAcceptedCallIds: new Set(),
    lastAutoAcceptPollErrorAt: 0,
    clientQuery: null,
    channelPolls: new Map(),
    pendingChannelPolls: [],
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tsEscape(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\//g, '\\/')
        .replace(/\|/g, '\\p')
        .replace(/\x07/g, '\\a')
        .replace(/\x08/g, '\\b')
        .replace(/\f/g, '\\f')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\x0b/g, '\\v')
        .replace(/ /g, '\\s');
}

function tsUnescape(value) {
    return String(value).replace(/\\([\\\/psabfnrtv])/g, (_, code) => {
        switch (code) {
            case '\\':
                return '\\';
            case '/':
                return '/';
            case 'p':
                return '|';
            case 's':
                return ' ';
            case 'a':
                return '\x07';
            case 'b':
                return '\b';
            case 'f':
                return '\f';
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case 'v':
                return '\x0b';
            default:
                return code;
        }
    });
}

function getTeamSpeakConnectConfig() {
    if (!TS3_URI) {
        throw new Error('TS3_URI is required for reconnect-based channel switching.');
    }

    let url;
    try {
        url = new URL(TS3_URI);
    } catch (error) {
        throw new Error(`TS3_URI is not a valid TeamSpeak URI: ${error.message}`);
    }

    if (url.protocol !== 'ts3server:') {
        throw new Error(`Unsupported TeamSpeak URI protocol: ${url.protocol}`);
    }

    const port = url.searchParams.get('port') || url.port;
    const address = port ? `${url.hostname}:${port}` : url.hostname;
    if (!address) throw new Error('TS3_URI does not contain a TeamSpeak server address.');

    return {
        address,
        nickname: url.searchParams.get('nickname') || '',
        password: url.searchParams.get('password') || '',
        token: url.searchParams.get('token') || '',
    };
}

function parseTsLine(line) {
    const fields = {};
    for (const token of line.trim().split(' ')) {
        const index = token.indexOf('=');
        if (index === -1) continue;
        fields[token.slice(0, index)] = tsUnescape(token.slice(index + 1));
    }
    return fields;
}

function parseTsRows(lines) {
    const rows = [];
    for (const line of lines) {
        if (!line || line.startsWith('error ')) continue;
        for (const row of line.split('|')) {
            if (row.trim()) rows.push(parseTsLine(row));
        }
    }
    return rows;
}

function parseArgs(input) {
    const args = [];
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    let match;
    while ((match = regex.exec(input)) !== null) {
        args.push((match[1] || match[2] || match[3]).replace(/\\(["'])/g, '$1'));
    }
    return args;
}

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

function isSwitchableChannelName(name) {
    return !String(name || '').trim().toLowerCase().startsWith('[spacer');
}

function normalizeContactId(input) {
    const raw = String(input || '').trim();
    if (raw.endsWith('@g.us')) {
        throw new Error('Group IDs cannot be invited to a WhatsApp call.');
    }
    if (raw.endsWith('@c.us')) return raw;

    let digits = raw.replace(/[^\d+]/g, '');
    if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
    digits = digits.replace(/^\+/, '');

    if (!/^\d{6,15}$/.test(digits)) {
        throw new Error(`Invalid phone number: ${raw}`);
    }

    return `${digits}@c.us`;
}

function parseContactGroups(raw) {
    try {
        const parsed = JSON.parse(raw || '{}');
        const groups = new Map();
        for (const [name, contacts] of Object.entries(parsed)) {
            if (!Array.isArray(contacts)) {
                throw new Error(`Contact group "${name}" must be an array.`);
            }
            groups.set(
                name.toLowerCase(),
                contacts.map(normalizeContactId),
            );
        }
        return groups;
    } catch (error) {
        console.error(`Ignoring invalid BRIDGE_CONTACT_GROUPS: ${error.message}`);
        return new Map();
    }
}

function resolveCallTargets(args) {
    if (args.length === 1) {
        const group = CONTACT_GROUPS.get(args[0].toLowerCase());
        if (group) return group;
    }

    return args.map(normalizeContactId);
}

function contactGroupsText() {
    if (CONTACT_GROUPS.size === 0) return 'none';
    return Array.from(CONTACT_GROUPS.keys()).sort().join(',');
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

function sendApiJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

function createApiServer(waClient) {
    // Keep endpoints in a registry so additional API versions and resources can
    // be added without turning the bot's main flow into a routing switch.
    const routes = new Map([
        [
            'GET /api/v1/health',
            async () => ({
                statusCode: 200,
                body: { ready: state.ready },
            }),
        ],
        [
            'GET /api/v1/calls/active/participants',
            async () => {
                const callStatus = await getLiveWhatsAppCallStatus(waClient);
                return {
                    statusCode: 200,
                    body: callStatus,
                };
            },
        ],
    ]);

    const server = http.createServer(async (request, response) => {
        const method = request.method || 'GET';
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        const handler = routes.get(`${method} ${pathname}`);

        if (!handler) {
            sendApiJson(response, 404, { error: 'Not found.' });
            return;
        }

        try {
            const result = await handler();
            sendApiJson(response, result.statusCode, result.body);
        } catch (error) {
            console.error(`Bridge API ${method} ${pathname} failed: ${error.message}`);
            sendApiJson(response, 503, {
                error: 'WhatsApp call status is temporarily unavailable.',
            });
        }
    });

    server.listen(API_PORT, API_HOST, () => {
        console.log(`Bridge API listening on http://${API_HOST}:${API_PORT}`);
    });
    server.on('error', (error) => {
        console.error(`Bridge API server error: ${error.message}`);
    });

    return server;
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

class ClientQuery {
    constructor() {
        this.socket = null;
        this.buffer = '';
        this.pending = [];
        this.onTextMessage = null;
        this.closed = Promise.resolve();
        this.resolveClosed = null;
        this.registeredHandlers = new Set();
        this.currentSchandlerid = null;
        this.ownClientId = null;
    }

    async connect() {
        this.socket = net.createConnection({ host: TS_HOST, port: TS_PORT });
        this.socket.setEncoding('utf8');
        this.closed = new Promise((resolve) => {
            this.resolveClosed = resolve;
        });
        this.socket.on('data', (chunk) => this.handleData(chunk));
        this.socket.on('error', (error) => {
            console.error(`ClientQuery socket error: ${error.message}`);
        });
        this.socket.on('close', () => {
            for (const pending of this.pending.splice(0)) {
                pending.reject(new Error('ClientQuery connection closed.'));
            }
            if (this.resolveClosed) this.resolveClosed();
        });

        await new Promise((resolve, reject) => {
            this.socket.once('connect', resolve);
            this.socket.once('error', reject);
        });

        await sleep(250);
        if (TS_API_KEY) {
            await this.command(`auth apikey=${tsEscape(TS_API_KEY)}`);
        }

        await this.registerTextMessages('0');
        if (this.currentSchandlerid) await this.registerTextMessages(this.currentSchandlerid);
        console.log('ClientQuery command listener registered on schandlerid=0.');
    }

    handleData(chunk) {
        this.buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).replace(/\r/g, '');
            this.buffer = this.buffer.slice(newlineIndex + 1);
            this.handleLine(line);
        }
    }

    handleLine(line) {
        if (!line) return;

        if (line.startsWith('notifytextmessage ')) {
            if (this.onTextMessage) this.onTextMessage(parseTsLine(line));
            return;
        }

        if (line.startsWith('selected schandlerid=')) {
            this.currentSchandlerid = parseTsLine(line).schandlerid || this.currentSchandlerid;
        }

        const pending = this.pending[0];
        if (!pending) {
            console.log(`ClientQuery: ${line}`);
            return;
        }

        pending.lines.push(line);
        if (line.startsWith('error ')) {
            this.pending.shift();
            const errorId = parseTsLine(line).id;
            if (errorId && errorId !== '0') {
                pending.reject(new Error(pending.lines.join('\n')));
            } else {
                pending.resolve(pending.lines);
            }
        }
    }

    command(text) {
        if (!this.socket || this.socket.destroyed) {
            return Promise.reject(new Error('ClientQuery is not connected.'));
        }

        return new Promise((resolve, reject) => {
            const pending = {
                lines: [],
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                const index = this.pending.indexOf(pending);
                if (index !== -1) this.pending.splice(index, 1);
                reject(new Error(`ClientQuery command timed out: ${text}`));
            }, 5000);
            this.pending.push(pending);
            this.socket.write(`${text}\n`);
        });
    }

    async registerTextMessages(schandlerid) {
        if (!schandlerid || this.registeredHandlers.has(schandlerid)) return;
        await this.command(
            `clientnotifyregister schandlerid=${schandlerid} event=notifytextmessage`,
        );
        this.registeredHandlers.add(schandlerid);
        console.log(`ClientQuery textmessage listener registered on schandlerid=${schandlerid}.`);
    }

    async refreshServerHandlerRegistration() {
        const whoami = await this.command('whoami');
        const whoamiLine = whoami.find((line) => !line.startsWith('error ')) || '';
        const state = parseTsLine(whoamiLine);
        this.ownClientId = state.clid || state.sclid || this.ownClientId;
        if (this.currentSchandlerid) await this.registerTextMessages(this.currentSchandlerid);
    }

    async reply(event, message) {
        const target = event.invokerid;
        if (!target) return;
        await this.command(
            `sendtextmessage targetmode=1 target=${target} msg=${tsEscape(message)}`,
        );
    }

    async getOwnClientInfo() {
        const lines = await this.command('whoami');
        const line = lines.find((entry) => !entry.startsWith('error ')) || '';
        const info = parseTsLine(line);
        this.ownClientId = info.clid || info.sclid || this.ownClientId;
        return info;
    }

    async listChannels() {
        const rows = parseTsRows(await this.command('channellist'));
        return rows
            .filter((row) => row.cid && row.channel_name)
            .map((row) => ({
                id: row.cid,
                name: row.channel_name,
                parentId: row.pid || '0',
                order: Number.parseInt(row.channel_order || '0', 10) || 0,
            }))
            .filter((channel) => isSwitchableChannelName(channel.name));
    }

    async listSwitchableChannels() {
        const [ownInfo, channels] = await Promise.all([
            this.getOwnClientInfo(),
            this.listChannels(),
        ]);
        const currentChannelId = ownInfo.cid || ownInfo.client_channel_id || null;
        return channels.filter((channel) => channel.id !== currentChannelId);
    }

    async moveSelfToChannel(channel) {
        const channelId = typeof channel === 'object' ? channel.id : channel;
        const channelName = typeof channel === 'object' ? channel.name : '';
        const ownInfo = await this.getOwnClientInfo();
        const clientId = ownInfo.clid || ownInfo.sclid || this.ownClientId;
        if (!clientId) throw new Error('Could not determine TeamSpeak client ID.');
        await this.command(
            `clientmove cid=${tsEscape(channelId)} clid=${tsEscape(clientId)}`,
        );
        await sleep(500);

        const movedInfo = await this.getOwnClientInfo();
        const movedChannelId = movedInfo.cid || movedInfo.client_channel_id || null;
        if (movedChannelId === channelId) return;

        if (!channelName) {
            throw new Error(
                `TeamSpeak still reports current channel ${movedChannelId || 'unknown'} after moving to ${channelId}.`,
            );
        }

        console.log(
            `TeamSpeak clientmove returned OK but stayed in ${movedChannelId || 'unknown'}; reconnecting to channel ${channelName} (${channelId}).`,
        );
        await this.reconnectToChannel(channel);
    }

    async reconnectToChannel(channel) {
        const config = getTeamSpeakConnectConfig();
        const connectParts = [
            `connect address=${tsEscape(config.address)}`,
            config.nickname ? `nickname=${tsEscape(config.nickname)}` : '',
            config.password ? `password=${tsEscape(config.password)}` : '',
            config.token ? `token=${tsEscape(config.token)}` : '',
            `channel=${tsEscape(channel.name)}`,
        ].filter(Boolean);

        try {
            await this.command('disconnect msg=Switching\\schannel');
        } catch (error) {
            if (!error.message.includes('not\\sconnected')) throw error;
        }

        let lastConnectError = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            await sleep(attempt === 0 ? 1000 : 1500);
            try {
                await this.command(connectParts.join(' '));
                lastConnectError = null;
                break;
            } catch (error) {
                lastConnectError = error;
                if (!error.message.includes('currently\\snot\\spossible')) throw error;
            }
        }
        if (lastConnectError) throw lastConnectError;

        for (let attempt = 0; attempt < 15; attempt += 1) {
            await sleep(1000);
            try {
                const info = await this.getOwnClientInfo();
                const currentChannelId = info.cid || info.client_channel_id || null;
                if (currentChannelId === channel.id) return;
            } catch (error) {
                if (!error.message.includes('not\\sconnected')) throw error;
            }
        }

        throw new Error(`TeamSpeak did not reconnect to channel ${channel.name}.`);
    }
}

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

async function createWhatsAppClient() {
    const client = new Client({
        authStrategy: new NoAuth(),
        userAgent: false,
        webVersionCache: {
            type: 'local',
            path: '/data/wwebjs_cache',
        },
        puppeteer: {
            executablePath: CHROMIUM_EXECUTABLE,
            headless: false,
            defaultViewport: null,
            userDataDir: CHROMIUM_PROFILE,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer=false',
                '--no-first-run',
                '--no-default-browser-check',
                '--password-store=basic',
                '--remote-debugging-address=0.0.0.0',
                '--remote-debugging-port=9222',
                '--remote-allow-origins=*',
                '--alsa-output-device=default',
                '--alsa-input-device=default',
                '--use-fake-ui-for-media-stream',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-session-crashed-bubble',
                `--window-size=${process.env.DISPLAY_WIDTH || '1440'},${process.env.DISPLAY_HEIGHT || '900'}`,
                '--start-maximized',
            ],
        },
        takeoverOnConflict: false,
        qrMaxRetries: 0,
        authTimeoutMs: 120000,
    });

    client.on('ready', () => {
        state.ready = true;
        state.whatsapp = null;
        state.recoveredEventListenersAttached = true;
        console.log('WhatsApp Web.js bot is ready.');
        client.pupPage
            .evaluate(() => navigator.userAgent)
            .then((userAgent) => {
                console.log(`WhatsApp Web runtime user agent: ${userAgent}`);
            })
            .catch((error) => {
                console.error(
                    `Could not read WhatsApp Web runtime user agent: ${error.message}`,
                );
            });
        attachWhatsAppPollVoteBridge(client).catch((error) => {
            console.error(`Could not attach WhatsApp poll vote bridge: ${error.message}`);
        });
    });

    client.on('authenticated', () => {
        console.log('WhatsApp Web.js authenticated.');
        setTimeout(() => {
            refreshWhatsAppReady(client).catch((error) => {
                console.error(`WhatsApp Web.js ready refresh failed: ${error.message}`);
            });
        }, 1000);
    });

    client.on('auth_failure', (message) => {
        console.error(`WhatsApp auth failure: ${message}`);
    });

    client.on('disconnected', (reason) => {
        state.ready = false;
        state.activeCallId = null;
        state.activeCall = null;
        console.error(`WhatsApp Web.js disconnected: ${reason}`);
    });

    client.on('call', (call) => {
        state.activeCall = call;
        state.activeCallId = call.id;
        console.log(
            `WhatsApp call observed: id=${call.id} from=${call.from} group=${call.isGroup} video=${call.isVideo} outgoing=${call.fromMe}`,
        );
        autoAcceptIncomingCall(client, call);
    });

    client.on('message', (message) => {
        handleWhatsAppMessage(client, message).catch((error) => {
            console.error(`WhatsApp message handler failed: ${error.message}`);
        });
    });

    client.on('message_create', (message) => {
        handleWhatsAppMessageCreate(message);
    });

    client.on('vote_update', (vote) => {
        handleWhatsAppPollVote(client, vote).catch((error) => {
            console.error(`WhatsApp poll vote handler failed: ${error.message}`);
        });
    });

    await client.initialize();
    await refreshWhatsAppReady(client);
    const readyPoller = setInterval(() => {
        if (state.ready) {
            clearInterval(readyPoller);
            return;
        }
        refreshWhatsAppReady(client).catch((error) => {
            console.error(`WhatsApp Web.js ready refresh failed: ${error.message}`);
        });
    }, 5000);
    readyPoller.unref();

    const autoAcceptPoller = setInterval(() => {
        pollIncomingWhatsAppCall(client).catch((error) => {
            const now = Date.now();
            if (now - state.lastAutoAcceptPollErrorAt > 30000) {
                console.error(`WhatsApp auto-accept poll failed: ${error.message}`);
                state.lastAutoAcceptPollErrorAt = now;
            }
        });
    }, AUTO_ACCEPT_POLL_MS);
    autoAcceptPoller.unref();

    return client;
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

async function attachWhatsAppPollVoteBridge(client) {
    if (!client.pupPage || client.pupPage.isClosed()) return;

    if (typeof client.pupPage.exposeFunction === 'function') {
        try {
            await client.pupPage.exposeFunction('__bridgePollVoteBulkUpsert', (event) => {
                handleWhatsAppPollVoteBulkUpsert(client, event).catch((error) => {
                    console.error(
                        `WhatsApp poll bulk-upsert handler failed: ${error.message}`,
                    );
                });
            });
        } catch (error) {
            if (!/already|exist/i.test(error.message)) throw error;
        }
    }

    const bridgeStatus = await client.pupPage.evaluate(() => {
        const result = {
            wwebjs: typeof window.WWebJS !== 'undefined',
            hookAttached: false,
            modulePresent: false,
        };

        let pollVoteModule = null;
        try {
            pollVoteModule = window.require('WAWebAddonPollVoteTableMode');
            result.modulePresent = true;
        } catch (error) {
            result.error = error.message;
            return result;
        }

        const mode = pollVoteModule?.pollVoteTableMode;
        if (
            mode &&
            typeof mode.bulkUpsert === 'function' &&
            !mode.bulkUpsert.__bridgePollVoteBridgeWrapped
        ) {
            const original = mode.bulkUpsert;
            mode.bulkUpsert = function (...args) {
                const keyValues = (key) => {
                    if (!key) return [];
                    const values = [
                        key._serialized,
                        key.id,
                        typeof key.toString === 'function' ? key.toString() : null,
                    ].filter(Boolean);
                    return Array.from(new Set(values.map(String)));
                };
                const jidValue = (jid) => {
                    return jid?._serialized || jid?.user || jid?.server || null;
                };
                const selectedIds = (value) => {
                    if (!value) return [];
                    if (value instanceof Uint8Array) return Array.from(value);
                    if (Array.isArray(value)) return value;
                    if (typeof value === 'object') {
                        return Object.keys(value)
                            .sort((left, right) => Number(left) - Number(right))
                            .map((key) => value[key]);
                    }
                    return [];
                };
                const events = (Array.isArray(args[0]) ? args[0] : []).map((vote) => ({
                    id: keyValues(vote.id),
                    parentKeys: [
                        ...keyValues(vote.pollUpdateParentKey),
                        ...keyValues(vote.parentMsgKey),
                    ],
                    chatIds: [
                        jidValue(vote.from),
                        jidValue(vote.to),
                    ].filter(Boolean),
                    voter:
                        jidValue(vote.author) ||
                        jidValue(vote.from) ||
                        vote.senderUserJid ||
                        null,
                    selectedOptionLocalIds: selectedIds(vote.selectedOptionLocalIds),
                    lastSuccessfulSelectedOptionLocalIds: selectedIds(
                        vote.lastSuccessfulSelectedOptionLocalIds,
                    ),
                    senderTimestampMs: vote.senderTimestampMs || vote.t || null,
                }));
                try {
                    for (const event of events) {
                        window.__bridgePollVoteBulkUpsert(event);
                    }
                } catch (error) {
                    console.error(`Bridge poll vote handler failed: ${error.message}`);
                }
                return original.apply(this, args);
            };
            mode.bulkUpsert.__bridgePollVoteBridgeWrapped = true;
            result.hookAttached = true;
        }

        return result;
    });

    console.log(`WhatsApp poll vote bridge attached: ${JSON.stringify(bridgeStatus)}`);
}

function requireClientQuery() {
    const query = state.clientQuery;
    if (!query || !query.socket || query.socket.destroyed) {
        throw new Error('TeamSpeak ClientQuery is not connected.');
    }
    return query;
}

function findChannelByName(channels, requestedName) {
    const normalized = requestedName.trim().toLowerCase();
    return channels.filter((channel) => channel.name.toLowerCase() === normalized);
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

function registerChannelPollIds(pollIds, pollState, pollMessage = null) {
    const ids = Array.from(new Set((pollIds || []).filter(Boolean)));
    if (ids.length === 0) return false;
    pollState.pollIds = Array.from(
        new Set([...(pollState.pollIds || []), ...ids]),
    );
    if (pollMessage) pollState.pollMessage = pollMessage;
    for (const pollId of ids) {
        state.channelPolls.set(pollId, pollState);
    }
    pruneChannelPolls();
    console.log(
        `Tracking TeamSpeak channel poll ${ids.join(',')} for chat=${pollState.chatId} page=${pollState.page}`,
    );
    return true;
}

function registerChannelPoll(pollId, pollState, pollMessage = null) {
    return registerChannelPollIds([pollId], pollState, pollMessage);
}

function queuePendingChannelPoll(pollState) {
    state.pendingChannelPolls.push(pollState);
    pruneChannelPolls();
    console.log(
        `Waiting for outgoing TeamSpeak channel poll ID for chat=${pollState.chatId} page=${pollState.page}`,
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

function handleWhatsAppMessageCreate(message) {
    if (!message.fromMe || state.pendingChannelPolls.length === 0) return;
    if (message.pollName && message.pollName !== 'Switch TeamSpeak channel') return;

    const pollIds = getMessageIdAliases(message);
    const pollId = pollIds[0] || null;
    if (!pollId) {
        console.error('Outgoing TeamSpeak channel poll still has no message ID.');
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
    registerChannelPollIds(pollIds, pollState, message);
}

async function switchToChannelByName(channelName) {
    if (!channelName) throw new Error('Missing TeamSpeak channel name.');

    const query = requireClientQuery();
    const channels = await query.listSwitchableChannels();
    const matches = findChannelByName(channels, channelName);
    if (matches.length === 0) {
        throw new Error(`TeamSpeak channel not found or already active: ${channelName}`);
    }
    if (matches.length > 1) {
        throw new Error(`TeamSpeak channel name is ambiguous: ${channelName}`);
    }

    await query.moveSelfToChannel(matches[0]);
    return matches[0];
}

async function sendChannelSwitchPoll(client, chatId, requestedBy, page = 0) {
    if (typeof Poll !== 'function') {
        throw new Error('The configured whatsapp-web.js build does not expose Poll support.');
    }

    const query = requireClientQuery();
    const channels = await query.listSwitchableChannels();
    if (channels.length === 0) {
        await client.sendMessage(chatId, 'No other TeamSpeak channels are available.');
        return;
    }

    const channelSlots = CHANNEL_POLL_MAX_OPTIONS - 1;
    const start = page * channelSlots;
    const pageChannels = channels.slice(start, start + channelSlots);
    if (pageChannels.length === 0) {
        await client.sendMessage(chatId, 'No more TeamSpeak channels are available.');
        return;
    }

    const hasMore = start + pageChannels.length < channels.length;
    const duplicateNames = getDuplicateChannelNames(channels);
    const options = pageChannels.map((channel) =>
        channelPollOptionName(channel, duplicateNames),
    );
    if (hasMore) options.push(SHOW_MORE_CHANNELS_OPTION);

    const poll = new Poll('Switch TeamSpeak channel', options, {
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
    if (registerChannelPollIds(pollIds, pollState, sentMessage)) {
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
            await message.reply(`Switched TeamSpeak channel to: ${channel.name}`);
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
            `Ignoring WhatsApp poll vote: no tracked TeamSpeak channel poll for ${pollId || 'unknown'}`,
        );
        return;
    }

    await processChannelPollSelection(client, pollState, vote.selectedOptions?.[0], {
        source: 'vote_update',
        voter: vote.voter,
    });
}

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
        const activeStates = getTrackedChannelPollStates().filter((state) => {
            return (
                !state.completed &&
                Date.now() - state.createdAt < 30 * 60 * 1000 &&
                chatIds.includes(state.chatId)
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
    if (!pollState.seenVoteKeys) pollState.seenVoteKeys = new Set();
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
    const query = requireClientQuery();
    console.log(`Switching TeamSpeak channel by WhatsApp poll ${source} to ${channel.name} (${channel.id}).`);
    try {
        await query.moveSelfToChannel(channel);
    } catch (error) {
        pollState.completed = false;
        console.error(
            `Could not switch TeamSpeak channel to ${channel.name} (${channel.id}): ${error.message}`,
        );
        await client.sendMessage(
            pollState.chatId,
            `Error switching TeamSpeak channel: ${error.message}`,
        );
        return;
    }
    await client.sendMessage(
        pollState.chatId,
        `Switched TeamSpeak channel to: ${channel.name}`,
    );
}

function pruneChannelPolls() {
    const expiresBefore = Date.now() - 30 * 60 * 1000;
    for (const [pollId, pollState] of state.channelPolls.entries()) {
        if (pollState.createdAt < expiresBefore) {
            state.channelPolls.delete(pollId);
        }
    }
    state.pendingChannelPolls = state.pendingChannelPolls.filter(
        (pollState) => pollState.createdAt >= expiresBefore,
    );
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

async function refreshWhatsAppReady(client) {
    const runtime = await inspectWhatsAppRuntime(client);

    state.whatsapp = runtime;

    if (!runtime.ready) {
        state.ready = false;
        return false;
    }

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

async function acceptActiveWhatsAppCall(waClient, call = null, options = {}) {
    const attempts = options.attempts || 1;
    const delayMs = options.delayMs || 0;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const acceptedCall =
                call && typeof call.accept === 'function'
                    ? await call.accept()
                    : await waClient.acceptCall();
            state.activeCall = acceptedCall || state.activeCall;
            state.activeCallId = acceptedCall?.id || state.activeCallId;
            return acceptedCall;
        } catch (error) {
            lastError = error;
            if (attempt < attempts && delayMs > 0) await sleep(delayMs);
        }
    }

    throw lastError;
}

function whatsappStatusText() {
    const runtime = state.whatsapp;
    if (!runtime) return `ready=${state.ready}`;
    return [
        `ready=${state.ready}`,
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

        const call =
            contactIds.length === 1
                ? await waClient.startCall(contactIds[0], { video: false })
                : await waClient.startGroupCall(contactIds, { video: false });
        state.activeCall = call;
        state.activeCallId = call.id;
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
        const call = await waClient.startGroupCall(contactIds, { video: false });
        state.activeCall = call;
        state.activeCallId = call.id;
        return `Started WhatsApp group voice call with ${contactIds.length} participant(s): ${call.id}`;
    }

    if (command === 'hangup' || command === 'end') {
        await waClient.endCall(state.activeCallId || undefined);
        state.activeCall = null;
        state.activeCallId = null;
        return 'Ended the current WhatsApp call.';
    }

    throw new Error(`Unknown command. Try: ${COMMAND_PREFIX} help`);
}

async function main() {
    const waClient = await createWhatsAppClient();
    createApiServer(waClient);

    if (!TS_API_KEY) {
        console.log('TS3_CLIENTQUERY_API_KEY is not set; WhatsApp is running without TeamSpeak command control.');
        return;
    }

    while (true) {
        try {
            const query = new ClientQuery();
            await query.connect();
            state.clientQuery = query;

            query.onTextMessage = async (event) => {
                if (query.ownClientId && event.invokerid === query.ownClientId) return;

                console.log(
                    `TeamSpeak message from ${event.invokername || event.invokeruid || event.invokerid}: ${event.msg || ''}`,
                );

                const commandText = extractCommand(event.msg || '');
                if (!commandText) return;

                try {
                    assertCommander(event);
                    const args = parseArgs(commandText);
                    const response = await handleCommand(waClient, args);
                    await query.reply(event, response);
                } catch (error) {
                    await query.reply(event, `Error: ${error.message}`);
                }
            };

            while (true) {
                const closed = await Promise.race([
                    query.closed.then(() => 'closed'),
                    sleep(5000).then(() => 'poll'),
                ]);
                if (closed === 'closed') break;

                try {
                    await query.refreshServerHandlerRegistration();
                } catch (error) {
                    console.error(`ClientQuery server handler not ready: ${error.message}`);
                }
            }
            console.error('ClientQuery command listener disconnected; reconnecting.');
            if (state.clientQuery === query) state.clientQuery = null;
        } catch (error) {
            console.error(`ClientQuery command listener not ready: ${error.message}`);
            state.clientQuery = null;
        }
        await sleep(5000);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
