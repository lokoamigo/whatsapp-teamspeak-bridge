'use strict';

const assert = require('assert');
const test = require('node:test');
const { VOICE_BACKEND } = require('../bot/config');
const state = require('../bot/state');
const { refreshWhatsAppReady } = require('../bot/whatsapp/readiness');
const {
    handleWhatsAppSwitchChannelCommand,
    startChannelPollCleanup,
} = require('../bot/whatsapp/channel-polls');

test('concurrent readiness consumers share one browser request and retry failures', async () => {
    let reads = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const client = {
        pupPage: {
            isClosed: () => false,
            evaluate: async () => { reads += 1; return pending; },
        },
    };
    const first = refreshWhatsAppReady(client);
    const second = refreshWhatsAppReady(client);
    assert.strictEqual(first, second);
    assert.strictEqual(reads, 1);
    release({ ready: false });
    await first;
    client.pupPage.evaluate = async () => { reads += 1; throw new Error('navigation'); };
    await assert.rejects(refreshWhatsAppReady(client), /navigation/);
    client.pupPage.evaluate = async () => { reads += 1; return { ready: false }; };
    await refreshWhatsAppReady(client);
    assert.strictEqual(reads, 3, 'success and failure both release the in-flight request');
});

test('channel polls have a capacity and expire even with no further messages', async (t) => {
    const previous = state.voiceChannels[VOICE_BACKEND];
    t.after(() => {
        state.voiceChannels[VOICE_BACKEND] = previous;
        state.channelPolls.clear();
        state.pendingChannelPolls = [];
    });
    state.voiceChannels[VOICE_BACKEND] = { listSwitchableChannels: async () => [{ id: 2, name: 'Lobby' }] };
    let id = 0;
    const client = {
        sendMessage: async () => ({ id: { id: `p${++id}` }, unusedPayload: Buffer.alloc(1024) }),
    };
    t.mock.method(console, 'log', () => {});
    for (let i = 0; i < 105; i++) {
        await handleWhatsAppSwitchChannelCommand(client, {
            from: `chat${i}`, reply: async (message) => { throw new Error(message); },
        }, { channelName: '' });
    }
    assert.strictEqual(state.channelPolls.size, 100);
    assert.strictEqual(state.pendingChannelPolls.length, 0);
    assert.strictEqual(state.channelPolls.has('p1'), false);
    assert.strictEqual(state.channelPolls.has('p105'), true);
    for (const poll of state.channelPolls.values()) {
        assert.strictEqual(poll.pollMessage, undefined, 'full message objects are not retained');
        poll.createdAt = Date.now() - 31 * 60 * 1000;
    }
    state.pendingChannelPolls.push({ createdAt: Date.now() - 31 * 60 * 1000 });
    let cleanup;
    t.mock.method(global, 'setInterval', (callback) => {
        cleanup = callback;
        return { unref() {} };
    });
    startChannelPollCleanup();
    cleanup();
    assert.strictEqual(state.channelPolls.size, 0);
    assert.strictEqual(state.pendingChannelPolls.length, 0);
});
