'use strict';

// Connection to the TeamSpeak 3 client's ClientQuery plugin.

const net = require('net');
const { TS_HOST, TS_PORT, TS_API_KEY, TS3_URI } = require('../config');
const { sleep } = require('../util');
const { tsEscape, parseTsLine, parseTsRows } = require('./protocol');

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

function isSwitchableChannelName(name) {
    return !String(name || '').trim().toLowerCase().startsWith('[spacer');
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
        const info = parseTsLine(whoamiLine);
        this.ownClientId = info.clid || info.sclid || this.ownClientId;
        if (this.currentSchandlerid) await this.registerTextMessages(this.currentSchandlerid);
    }

    async reply(event, message) {
        const target = event.invokerid;
        if (!target) return;
        await this.command(
            `sendtextmessage targetmode=1 target=${target} msg=${tsEscape(message)}`,
        );
    }

    // targetmode=2 posts to the bridge client's current channel.
    async sendChannelMessage(message) {
        const ownInfo = await this.getOwnClientInfo();
        const channelId = ownInfo.cid || ownInfo.client_channel_id;
        if (!channelId) throw new Error('Could not determine the TeamSpeak channel.');
        await this.command(
            `sendtextmessage targetmode=2 target=${tsEscape(channelId)} msg=${tsEscape(message)}`,
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

    async moveSelfToChannel(channel, { allowReconnect = true } = {}) {
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

        if (!channelName || !allowReconnect) {
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

module.exports = { ClientQuery, getTeamSpeakConnectConfig, isSwitchableChannelName };
