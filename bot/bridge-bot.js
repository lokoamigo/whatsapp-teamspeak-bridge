'use strict';

const net = require('net');
const { Client, ClientInfo, NoAuth } = require('whatsapp-web.js');

const TS_HOST = process.env.TS3_CLIENTQUERY_HOST || '127.0.0.1';
const TS_PORT = Number.parseInt(process.env.TS3_CLIENTQUERY_PORT || '25639', 10);
const TS_API_KEY = (process.env.TS3_CLIENTQUERY_API_KEY || '').trim();
const CHROMIUM_EXECUTABLE =
    process.env.WWEBJS_CHROMIUM_EXECUTABLE || '/usr/bin/chromium';
const CHROMIUM_PROFILE = process.env.WWEBJS_CHROMIUM_PROFILE || '/data/chromium';
const COMMAND_PREFIX = process.env.BRIDGE_COMMAND_PREFIX || '!wa';
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

function parseTsLine(line) {
    const fields = {};
    for (const token of line.trim().split(' ')) {
        const index = token.indexOf('=');
        if (index === -1) continue;
        fields[token.slice(0, index)] = tsUnescape(token.slice(index + 1));
    }
    return fields;
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
    if (!activeCallId) state.activeCall = null;
    return activeCallId;
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
        this.ownClientId = state.clid || this.ownClientId;
        if (this.currentSchandlerid) await this.registerTextMessages(this.currentSchandlerid);
    }

    async reply(event, message) {
        const target = event.invokerid;
        if (!target) return;
        await this.command(
            `sendtextmessage targetmode=1 target=${target} msg=${tsEscape(message)}`,
        );
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
        console.log('WhatsApp Web.js bot is ready.');
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
    return client;
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
        `Auto-accept scheduled: id=${callId} from=${call.peerJid || 'unknown'} group=${call.isGroup === true} video=${call.isVideo === true}`,
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
            acceptCall: false,
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
            result.acceptCall = typeof window.WWebJS?.acceptCall === 'function';
            result.addParticipantToCall =
                typeof window.WWebJS?.addParticipantToCall === 'function';
            result.ready = result.hasSynced && result.wwebjs && result.addParticipantToCall;

            if (result.ready) {
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
    let runtime = await inspectWhatsAppRuntime(client);

    state.whatsapp = runtime;

    if (!runtime.ready) {
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
            `WhatsApp Web.js recovered ready state: state=${runtime.state} hasSynced=${runtime.hasSynced} wwebjs=${runtime.wwebjs} addParticipantToCall=${runtime.addParticipantToCall}`,
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
            if (!state.ready) await refreshWhatsAppReady(waClient);
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
        `acceptApi=${runtime.acceptCall === true}`,
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

    if (!state.ready && !(await refreshWhatsAppReady(waClient))) {
        throw new Error(`WhatsApp Web.js is not ready yet (${whatsappStatusText()}).`);
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

    if (!TS_API_KEY) {
        console.log('TS3_CLIENTQUERY_API_KEY is not set; WhatsApp is running without TeamSpeak command control.');
        return;
    }

    while (true) {
        try {
            const query = new ClientQuery();
            await query.connect();

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
        } catch (error) {
            console.error(`ClientQuery command listener not ready: ${error.message}`);
        }
        await sleep(5000);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
