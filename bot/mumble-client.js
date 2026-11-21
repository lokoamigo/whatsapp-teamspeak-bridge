'use strict';

// Minimal Mumble control-channel client for text commands. It speaks the TCP
// protocol (TLS + length-prefixed protobuf) without audio: the bot connects as
// its own self-muted, self-deafened user next to the Mumble GUI client.
// Protocol reference: https://github.com/mumble-voip/mumble/blob/master/src/Mumble.proto

const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { execFile } = require('child_process');

const DEFAULT_PORT = 64738;
const PING_INTERVAL_MS = 10000;
const CONNECT_TIMEOUT_MS = 20000;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
// Server defaults are 1 message/s with a burst of 5 (pings included); keep
// one in reserve for timing jitter.
const RATE_LIMIT_PER_SECOND = 1;
const RATE_LIMIT_BURST = 4;

const MessageType = {
    Version: 0,
    UDPTunnel: 1,
    Authenticate: 2,
    Ping: 3,
    Reject: 4,
    ServerSync: 5,
    ChannelRemove: 6,
    ChannelState: 7,
    UserRemove: 8,
    UserState: 9,
    TextMessage: 11,
    PermissionDenied: 12,
};

// --- protobuf (proto2 subset: varint and length-delimited fields) -----------

function encodeVarint(value) {
    let v = BigInt(value);
    const bytes = [];
    while (v > 0x7fn) {
        bytes.push(Number(v & 0x7fn) | 0x80);
        v >>= 7n;
    }
    bytes.push(Number(v));
    return Buffer.from(bytes);
}

// fields: [fieldNumber, value] pairs. Numbers/booleans/bigints are varints,
// strings and Buffers are length-delimited. Arrays repeat the field.
function encodeMessage(fields) {
    const parts = [];
    for (const [number, raw] of fields) {
        if (raw === undefined || raw === null) continue;
        for (const value of Array.isArray(raw) ? raw : [raw]) {
            if (typeof value === 'string' || Buffer.isBuffer(value)) {
                const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
                parts.push(encodeVarint((number << 3) | 2), encodeVarint(data.length), data);
            } else {
                const numeric = typeof value === 'boolean' ? Number(value) : value;
                parts.push(encodeVarint(number << 3), encodeVarint(numeric));
            }
        }
    }
    return Buffer.concat(parts);
}

function decodeVarint(buffer, offset) {
    let result = 0n;
    let shift = 0n;
    let position = offset;
    while (position < buffer.length) {
        const byte = buffer[position++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value: result, offset: position };
        shift += 7n;
        if (shift > 63n) break;
    }
    throw new Error('Malformed protobuf varint.');
}

// Returns Map<fieldNumber, Array<bigint|Buffer>>.
function decodeMessage(buffer) {
    const fields = new Map();
    let offset = 0;
    while (offset < buffer.length) {
        const key = decodeVarint(buffer, offset);
        offset = key.offset;
        const number = Number(key.value >> 3n);
        const wireType = Number(key.value & 7n);
        let value;
        if (wireType === 0) {
            ({ value, offset } = decodeVarint(buffer, offset));
        } else if (wireType === 2) {
            const length = decodeVarint(buffer, offset);
            const end = length.offset + Number(length.value);
            if (end > buffer.length) throw new Error('Truncated protobuf field.');
            value = buffer.subarray(length.offset, end);
            offset = end;
        } else if (wireType === 1 || wireType === 5) {
            const size = wireType === 1 ? 8 : 4;
            if (offset + size > buffer.length) throw new Error('Truncated protobuf field.');
            value = buffer.subarray(offset, offset + size);
            offset += size;
        } else {
            throw new Error(`Unsupported protobuf wire type ${wireType}.`);
        }
        if (!fields.has(number)) fields.set(number, []);
        fields.get(number).push(value);
    }
    return fields;
}

function has(fields, number) {
    return fields.has(number);
}

function getUint(fields, number, fallback = undefined) {
    const values = fields.get(number);
    if (!values || values.length === 0) return fallback;
    const value = values[values.length - 1];
    return typeof value === 'bigint' ? Number(value) : fallback;
}

function getBool(fields, number, fallback = undefined) {
    const value = getUint(fields, number);
    return value === undefined ? fallback : value !== 0;
}

function getString(fields, number, fallback = undefined) {
    const values = fields.get(number);
    if (!values || values.length === 0) return fallback;
    const value = values[values.length - 1];
    return Buffer.isBuffer(value) ? value.toString('utf8') : fallback;
}

// Repeated uint32, accepting both unpacked (proto2 default) and packed encoding.
function getRepeatedUint(fields, number) {
    const result = [];
    for (const value of fields.get(number) || []) {
        if (typeof value === 'bigint') {
            result.push(Number(value));
            continue;
        }
        let offset = 0;
        while (offset < value.length) {
            const decoded = decodeVarint(value, offset);
            result.push(Number(decoded.value));
            offset = decoded.offset;
        }
    }
    return result;
}

// --- text helpers ------------------------------------------------------------

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Mumble text messages are HTML. Reduce them to the plain text a user typed.
function mumbleHtmlToText(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
            if (entity[0] === '#') {
                const code =
                    entity[1].toLowerCase() === 'x'
                        ? Number.parseInt(entity.slice(2), 16)
                        : Number.parseInt(entity.slice(1), 10);
                return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
            }
            const decoded = HTML_ENTITIES[entity.toLowerCase()];
            return decoded === undefined ? match : decoded;
        })
        .replace(/ /g, ' ')
        .trim();
}

function textToMumbleHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '<br/>');
}

// --- configuration helpers ---------------------------------------------------

// Parses mumble://[user[:password]@]host[:port][/Channel/Path][?query].
function parseMumbleUri(uri) {
    const raw = String(uri || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('mumble://')) throw new Error('Mumble URI must start with mumble://.');
    const url = new URL(raw);
    if (!url.hostname) throw new Error('Mumble URI has no server host.');
    const decode = (value) => (value ? decodeURIComponent(value) : '');
    const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Mumble URI has an invalid port.');
    }
    return {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port,
        username: decode(url.username),
        password: decode(url.password),
        channelPath: url.pathname
            .split('/')
            .filter(Boolean)
            .map((segment) => decode(segment)),
    };
}

function fileExists(file) {
    try {
        fs.accessSync(file, fs.constants.R_OK);
        return true;
    } catch (_error) {
        return false;
    }
}

// The bot uses a persistent self-signed certificate: it gives the bot a stable
// identity (registration/ACLs on the server) and lets the server replace a
// stale "ghost" session with the same certificate after a reconnect.
async function ensureClientCertificate(directory, commonName) {
    const certFile = path.join(directory, 'cert.pem');
    const keyFile = path.join(directory, 'key.pem');
    if (!fileExists(certFile) || !fileExists(keyFile)) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const subjectName = String(commonName || 'WhatsAppBridge-Bot').replace(/[^\w.@-]/g, '_');
        await new Promise((resolve, reject) => {
            execFile(
                'openssl',
                [
                    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
                    '-days', '7300',
                    '-subj', `/CN=${subjectName}`,
                    '-keyout', keyFile,
                    '-out', certFile,
                ],
                { timeout: 30000 },
                (error, _stdout, stderr) => {
                    if (error) reject(new Error(`openssl failed: ${(stderr || error.message).trim()}`));
                    else resolve();
                },
            );
        });
        fs.chmodSync(keyFile, 0o600);
    }
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

// Trust on first use for servers without a CA-valid certificate (the usual
// self-signed Murmur setup), like the Mumble GUI client does. A changed
// fingerprint is refused until the pin file entry is removed.
function createTofuVerifier(pinFile) {
    return (host, port, peerCertificate, authorized) => {
        if (authorized) return { trusted: true, pinned: false };
        if (!peerCertificate || !peerCertificate.raw) {
            throw new Error('Mumble server sent no certificate.');
        }
        const fingerprint = crypto.createHash('sha256').update(peerCertificate.raw).digest('hex');
        const key = `${host}:${port}`;
        let pins = {};
        try {
            pins = JSON.parse(fs.readFileSync(pinFile, 'utf8')) || {};
        } catch (_error) {
            pins = {};
        }
        if (pins[key] === fingerprint) return { trusted: true, pinned: false };
        if (pins[key]) {
            throw new Error(
                `Mumble server certificate for ${key} changed (sha256 ${fingerprint}). ` +
                    `If this is expected, remove the "${key}" entry from ${pinFile}.`,
            );
        }
        pins[key] = fingerprint;
        fs.mkdirSync(path.dirname(pinFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(pinFile, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
        return { trusted: true, pinned: true, fingerprint };
    };
}

// --- client ------------------------------------------------------------------

class MumbleClient extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.session = null;
        this.synced = false;
        this.channels = new Map();
        this.users = new Map();
        this.pingTimer = null;
        this.limited = { queue: [], level: 0, updatedAt: Date.now(), timer: null };
        this.closeReason = null;
        this.closed = new Promise((resolve) => {
            this.resolveClosed = resolve;
        });
    }

    connect() {
        const { host, port = DEFAULT_PORT, cert, key, verifyServer } = this.options;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.off('synced', onSynced);
                if (error) {
                    this.close(error.message);
                    reject(error);
                } else {
                    resolve();
                }
            };
            const onSynced = () => finish();
            const timer = setTimeout(
                () => finish(new Error(`Timed out connecting to Mumble server ${host}:${port}.`)),
                this.options.connectTimeoutMs || CONNECT_TIMEOUT_MS,
            );
            this.on('synced', onSynced);
            this.closed.then((reason) => finish(new Error(reason || 'Mumble connection closed.')));

            const socket = tls.connect({
                host,
                port,
                servername: net.isIP(host) ? undefined : host,
                cert,
                key,
                rejectUnauthorized: false,
            });
            this.socket = socket;
            socket.setNoDelay(true);
            socket.on('secureConnect', () => {
                try {
                    if (verifyServer) {
                        const result = verifyServer(host, port, socket.getPeerCertificate(), socket.authorized);
                        if (result && result.pinned) this.emit('serverPinned', result.fingerprint);
                    } else if (!socket.authorized) {
                        throw new Error(`Untrusted Mumble server certificate: ${socket.authorizationError}`);
                    }
                } catch (error) {
                    finish(error);
                    return;
                }
                this.handshake();
            });
            socket.on('data', (chunk) => this.onData(chunk));
            socket.on('error', (error) => this.close(error.message));
            socket.on('close', () => this.close(this.closeReason || 'Mumble connection closed.'));
        });
    }

    handshake() {
        const [major, minor, patch] = [1, 4, 0];
        this.send(
            MessageType.Version,
            encodeMessage([
                [1, (major << 16) | (minor << 8) | patch],
                [2, this.options.release || 'whatsapp-bridge'],
                [3, 'Linux'],
                [4, ''],
                [5, (BigInt(major) << 48n) | (BigInt(minor) << 32n) | (BigInt(patch) << 16n)],
            ]),
        );
        this.send(
            MessageType.Authenticate,
            encodeMessage([
                [1, this.options.username],
                [2, this.options.password || undefined],
                [3, this.options.tokens || []],
                [5, true],
                [6, 1], // client_type = BOT (Mumble 1.5+; ignored by older servers)
            ]),
        );
        this.sendPing();
        this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    }

    send(type, payload) {
        if (!this.socket || this.socket.destroyed) return false;
        const header = Buffer.alloc(6);
        header.writeUInt16BE(type, 0);
        header.writeUInt32BE(payload.length, 2);
        this.socket.write(Buffer.concat([header, payload]));
        return true;
    }

    // Pings fill the server's rate-limit bucket too, but must never be delayed.
    sendPing() {
        this.drainLimited();
        this.limited.level += 1;
        this.send(MessageType.Ping, encodeMessage([[1, BigInt(Date.now())]]));
    }

    // The server rate-limits UserState, TextMessage and ChannelState per user
    // with a shared leaky bucket (messagelimit=1/s, messageburst=5 by default)
    // and silently drops what exceeds it. Mirror it with some headroom and
    // queue instead. A queued message with the same key is replaced.
    sendLimited(type, payload, key = null) {
        const { queue } = this.limited;
        const index = key === null ? -1 : queue.findIndex((item) => item.key === key);
        if (index >= 0) queue[index] = { type, payload, key };
        else queue.push({ type, payload, key });
        this.flushLimited();
        return true;
    }

    drainLimited() {
        const limited = this.limited;
        const now = Date.now();
        const rate = this.options.messageLimit || RATE_LIMIT_PER_SECOND;
        limited.level = Math.max(0, limited.level - ((now - limited.updatedAt) / 1000) * rate);
        limited.updatedAt = now;
    }

    flushLimited() {
        const limited = this.limited;
        if (limited.timer) return;
        const rate = this.options.messageLimit || RATE_LIMIT_PER_SECOND;
        const burst = this.options.messageBurst || RATE_LIMIT_BURST;
        while (limited.queue.length > 0) {
            this.drainLimited();
            if (limited.level + 1 > burst) {
                const waitMs = Math.ceil(((limited.level + 1 - burst) / rate) * 1000) + 50;
                limited.timer = setTimeout(() => {
                    limited.timer = null;
                    this.flushLimited();
                }, waitMs);
                return;
            }
            const item = limited.queue.shift();
            limited.level += 1;
            this.send(item.type, item.payload);
        }
    }

    close(reason) {
        if (!this.closeReason) this.closeReason = reason || 'Mumble connection closed.';
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        clearTimeout(this.limited.timer);
        this.limited.timer = null;
        this.limited.queue = [];
        if (this.socket && !this.socket.destroyed) this.socket.destroy();
        this.resolveClosed(this.closeReason);
    }

    onData(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length >= 6) {
            const type = this.buffer.readUInt16BE(0);
            const length = this.buffer.readUInt32BE(2);
            if (length > MAX_PACKET_BYTES) {
                this.close(`Mumble packet too large (${length} bytes).`);
                return;
            }
            if (this.buffer.length < 6 + length) return;
            const payload = this.buffer.subarray(6, 6 + length);
            this.buffer = this.buffer.subarray(6 + length);
            try {
                this.onPacket(type, payload);
            } catch (error) {
                this.emit('protocolError', error);
            }
        }
    }

    onPacket(type, payload) {
        if (type === MessageType.UDPTunnel || type === MessageType.Ping) return;
        const fields = decodeMessage(payload);
        switch (type) {
            case MessageType.Reject: {
                const reason = getString(fields, 2) || `type ${getUint(fields, 1, 0)}`;
                this.close(`Mumble server rejected the connection: ${reason}`);
                break;
            }
            case MessageType.ServerSync:
                this.session = getUint(fields, 1);
                this.synced = true;
                this.emit('synced');
                break;
            case MessageType.ChannelState:
                this.onChannelState(fields);
                break;
            case MessageType.ChannelRemove:
                this.channels.delete(getUint(fields, 1));
                this.emit('channelsChanged');
                break;
            case MessageType.UserState:
                this.onUserState(fields);
                break;
            case MessageType.UserRemove: {
                const session = getUint(fields, 1);
                const user = this.users.get(session);
                this.users.delete(session);
                if (session === this.session) {
                    const reason = getString(fields, 3);
                    this.close(`Removed from Mumble server${reason ? `: ${reason}` : '.'}`);
                } else if (user) {
                    this.emit('userRemoved', user);
                }
                break;
            }
            case MessageType.TextMessage: {
                const actor = getUint(fields, 1);
                this.emit('textMessage', {
                    actor,
                    user: actor === undefined ? undefined : this.users.get(actor),
                    sessions: getRepeatedUint(fields, 2),
                    channelIds: getRepeatedUint(fields, 3),
                    treeIds: getRepeatedUint(fields, 4),
                    message: getString(fields, 5, ''),
                });
                break;
            }
            case MessageType.PermissionDenied:
                this.emit('permissionDenied', {
                    permission: getUint(fields, 1),
                    channelId: getUint(fields, 2),
                    reason: getString(fields, 4),
                    type: getUint(fields, 5),
                });
                break;
            default:
                break;
        }
    }

    onChannelState(fields) {
        const id = getUint(fields, 1);
        if (id === undefined) return;
        const channel = this.channels.get(id) || { id, parent: undefined, name: '' };
        if (has(fields, 2)) channel.parent = getUint(fields, 2);
        if (has(fields, 3)) channel.name = getString(fields, 3, '');
        this.channels.set(id, channel);
        this.emit('channelsChanged');
    }

    onUserState(fields) {
        const session = getUint(fields, 1);
        if (session === undefined) return;
        const existing = this.users.get(session);
        const user = existing || { session, name: '', channelId: 0, hash: '', userId: undefined };
        if (has(fields, 3)) user.name = getString(fields, 3, '');
        if (has(fields, 4)) user.userId = getUint(fields, 4);
        if (has(fields, 5)) user.channelId = getUint(fields, 5, 0);
        if (has(fields, 9)) user.selfMute = getBool(fields, 9, false);
        if (has(fields, 10)) user.selfDeaf = getBool(fields, 10, false);
        if (has(fields, 15)) user.hash = getString(fields, 15, '').toLowerCase();
        this.users.set(session, user);
        this.emit('userState', user, { created: !existing, movedChannel: has(fields, 5) });
    }

    get self() {
        return this.session === null ? undefined : this.users.get(this.session);
    }

    findUserByName(name) {
        const wanted = String(name || '').toLowerCase();
        if (!wanted) return undefined;
        for (const user of this.users.values()) {
            if (user.session !== this.session && user.name.toLowerCase() === wanted) return user;
        }
        return undefined;
    }

    // Resolves a channel path (names below the root channel) to a channel id.
    findChannelByPath(segments) {
        let current = 0;
        for (const segment of segments || []) {
            const wanted = segment.toLowerCase();
            const child = [...this.channels.values()].find(
                (channel) => channel.parent === current && channel.name.toLowerCase() === wanted,
            );
            if (!child) return undefined;
            current = child.id;
        }
        return this.channels.has(current) ? current : undefined;
    }

    channelName(id) {
        const channel = this.channels.get(id);
        return channel ? channel.name || 'Root' : `#${id}`;
    }

    moveToChannel(channelId) {
        this.sendLimited(
            MessageType.UserState,
            encodeMessage([[1, this.session], [5, channelId]]),
            'move',
        );
    }

    setSelfMuteDeaf(mute, deaf) {
        this.sendLimited(
            MessageType.UserState,
            encodeMessage([[1, this.session], [9, mute], [10, deaf]]),
            'selfMuteDeaf',
        );
    }

    sendTextMessage({ sessions = [], channelIds = [], treeIds = [], text }) {
        return this.sendLimited(
            MessageType.TextMessage,
            encodeMessage([
                [2, sessions],
                [3, channelIds],
                [4, treeIds],
                [5, textToMumbleHtml(text)],
            ]),
        );
    }
}

module.exports = {
    MumbleClient,
    MessageType,
    createTofuVerifier,
    decodeMessage,
    encodeMessage,
    ensureClientCertificate,
    mumbleHtmlToText,
    parseMumbleUri,
    textToMumbleHtml,
    getRepeatedUint,
};
