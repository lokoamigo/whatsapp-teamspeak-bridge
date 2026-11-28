'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { textToMumbleHtml } = require('./client');
const { createMumbleCommandHandler } = require('./command-handler');

const MAX_LINE = 65536;
const MAX_PENDING = 32;

// Local control only: the Rust helper owns the single Mumble connection and
// audio identity. Node never creates a second Mumble session in native mode.
class NativeMumbleClient extends EventEmitter {
    constructor({ socketPath, log = console, retryMs = 1000, timeoutMs = 15000 }) {
        super();
        this.socketPath = socketPath;
        this.log = log;
        this.retryMs = retryMs;
        this.timeoutMs = timeoutMs;
        this.pending = new Map();
        this.sequence = 0;
        this.socket = null;
        this.connected = false;
        this.stopped = false;
        this.cancelRetry = null;
        this.stateVersion = 0;
        this.lastErrorAt = -Infinity;
    }

    request(op, parameters = {}) {
        const socket = this.socket;
        if (!socket || socket.destroyed || !socket.writable || socket.connecting) {
            return Promise.reject(new Error('The native Mumble helper is unavailable.'));
        }
        if (op !== 'status' && op !== 'attach' && !this.connected) {
            return Promise.reject(new Error('The native Mumble client is not connected.'));
        }
        if (this.pending.size >= MAX_PENDING || socket.writableLength > MAX_LINE * 2) {
            return Promise.reject(new Error('The native Mumble command queue is full.'));
        }
        const id = ++this.sequence;
        const line = JSON.stringify({ ...parameters, id, op });
        if (Buffer.byteLength(line) > MAX_LINE) return Promise.reject(new Error('Native Mumble request is too large.'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('The native Mumble request timed out.'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            socket.write(`${line}\n`);
        });
    }

    handleMessage(message) {
        if (message.event) {
            if (message.event === 'connected' || message.event === 'disconnected') {
                this.connected = message.event === 'connected';
                this.stateVersion += 1;
            }
            this.emit(message.event, message);
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
    }

    async run() {
        while (!this.stopped) {
            const socket = net.createConnection(this.socketPath);
            this.socket = socket;
            socket.setEncoding('utf8');
            let buffer = '';
            const closed = new Promise((resolve) => socket.once('close', () => {
                this.failPending();
                resolve();
            }));
            socket.on('error', () => {}); // connect/close paths report a bounded diagnostic.
            socket.on('data', (chunk) => {
                buffer += chunk;
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (Buffer.byteLength(line) > MAX_LINE) { socket.destroy(); return; }
                    try { this.handleMessage(JSON.parse(line)); }
                    catch (_) { socket.destroy(); return; }
                }
                if (Buffer.byteLength(buffer) > MAX_LINE) socket.destroy();
            });
            try {
                await new Promise((resolve, reject) => {
                    const finish = (error) => {
                        socket.off('connect', onConnect);
                        socket.off('error', onError);
                        socket.off('close', onClose);
                        if (error) reject(error);
                        else resolve();
                    };
                    const onConnect = () => finish();
                    const onError = (error) => finish(error);
                    const onClose = () => finish(new Error('Native Mumble helper closed.'));
                    socket.once('connect', onConnect);
                    socket.once('error', onError);
                    socket.once('close', onClose);
                });
                const version = this.stateVersion;
                const status = await this.request('attach');
                if (version === this.stateVersion) this.connected = status.connected === true;
                this.emit('attached', status);
                await closed;
            } catch (_) {
                if (!this.stopped && Date.now() - this.lastErrorAt >= 60000) {
                    this.lastErrorAt = Date.now();
                    this.log.error('Native Mumble helper unavailable; reconnecting.');
                }
            } finally {
                this.connected = false;
                socket.destroy();
                this.failPending();
                if (this.socket === socket) this.socket = null;
            }
            if (!this.stopped) await new Promise((resolve) => {
                const timer = setTimeout(resolve, this.retryMs);
                this.cancelRetry = () => { clearTimeout(timer); resolve(); };
            });
        }
    }

    stop() {
        this.stopped = true;
        this.cancelRetry?.();
        this.socket?.destroy();
    }

    failPending() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('The native Mumble helper disconnected.'));
        }
        this.pending.clear();
    }

    listSwitchableChannels() { return this.request('channels'); }
    moveToChannel(channel) { return this.request('move', { channel: Number(channel.id) }); }
    async roster() {
        const { channel, users } = await this.request('roster');
        return { channel, users: users.map((user) => ({ ...user, key: user.session })) };
    }
    sendPrivateMessage(session, text) { return this.request('send_text', { session, text: textToMumbleHtml(text) }); }
    sendChannelMessage(text) { return this.request('send_channel', { text: textToMumbleHtml(text) }); }
}

function createNativeMumbleControl(options) {
    const client = new NativeMumbleClient(options);
    const onMessage = createMumbleCommandHandler(options);
    client.on('text', (event) => {
        onMessage(event, (text) => client.request('send_text', {
            session: event.actor, text: textToMumbleHtml(text),
        })).catch((error) => (options.log || console).error(`Native Mumble command failed: ${error.message}`));
    });
    return client;
}

module.exports = { NativeMumbleClient, createNativeMumbleControl };
