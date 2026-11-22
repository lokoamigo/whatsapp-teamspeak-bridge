'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { PassThrough } = require('stream');
const test = require('node:test');
const { createAudioReconciler, startAudioRouter } = require('../bot/audio/router');

function audioServer() {
    const data = {
        sinks: [{ name: 'ts_out', index: 1 }, { name: 'wa_out', index: 2 }],
        sources: [{ name: 'ts_mic', index: 3 }, { name: 'wa_mic', index: 4 }],
        'sink-inputs': [],
        'source-outputs': [],
    };
    const defaults = { sink: 'wa_out', source: 'ts_mic' };
    const commands = [];
    const pactl = async (args) => {
        commands.push(args);
        if (args[0] === '--format=json') return JSON.stringify(data[args[2]]);
        if (args[0].startsWith('get-default-')) return defaults[args[0].slice(12)];
        if (args[0].startsWith('set-default-')) defaults[args[0].slice(12)] = args[1];
        if (args[0] === 'load-module') {
            const sink = args[1] === 'module-null-sink';
            const prefix = sink ? 'sink_name=' : 'source_name=';
            data[sink ? 'sinks' : 'sources'].push({
                name: args.find((arg) => arg.startsWith(prefix)).slice(prefix.length),
                index: sink ? 1 : 3,
            });
        }
        if (args[0].startsWith('move-')) {
            const sink = args[0] === 'move-sink-input';
            const entry = data[sink ? 'sink-inputs' : 'source-outputs']
                .find((item) => item.index === Number(args[1]));
            entry[sink ? 'sink' : 'source'] = data[sink ? 'sinks' : 'sources']
                .find((device) => device.name === args[2]).index;
        }
        return '';
    };
    return { data, defaults, commands, ...createAudioReconciler({ pactl, pause: async () => {} }) };
}

const stream = (index, binary, routing) => ({
    index, properties: { 'application.process.binary': binary }, ...routing,
});
const mutations = (server) => server.commands.filter((args) =>
    !args[0].startsWith('get-') && args[0] !== '--format=json',
);

test('audio snapshots leave correct defaults and routes untouched', async () => {
    const server = audioServer();
    server.data['sink-inputs'] = [stream(10, 'chromium', { sink: 2 }), stream(11, 'mumble', { sink: 1 })];
    server.data['source-outputs'] = [stream(12, 'mumble', { source: 4 })];
    await server.reconcile();
    await server.reconcile();
    assert.deepStrictEqual(mutations(server), []);
});

test('audio routes both backends and nudges each new Chromium capture once', async () => {
    const server = audioServer();
    server.data['sink-inputs'] = [
        stream(10, 'chromium', { sink: 1 }),
        stream(11, 'mumble', { sink: 2 }),
        stream(12, 'ts3client_linux_amd64', { sink: 2 }),
        stream(13, 'unrelated', { sink: 1 }),
    ];
    server.data['source-outputs'] = [
        stream(20, 'chromium', { source: 4 }),
        stream(21, 'mumble', { source: 3 }),
        stream(22, 'ts3client_linux_amd64', { source: 3 }),
    ];
    await server.reconcile();
    assert.deepStrictEqual(mutations(server), [
        ['move-sink-input', '10', 'wa_out'],
        ['move-sink-input', '11', 'ts_out'],
        ['move-sink-input', '12', 'ts_out'],
        ['set-default-source', 'wa_mic'],
        ['set-default-source', 'ts_mic'],
        ['move-source-output', '20', 'ts_mic'],
        ['move-source-output', '21', 'wa_mic'],
        ['move-source-output', '22', 'wa_mic'],
    ]);
    server.commands.length = 0;
    await server.reconcile();
    assert.deepStrictEqual(mutations(server), [], 'self-generated events cause no more moves or nudges');
    server.reset();
    await server.reconcile();
    assert.deepStrictEqual(mutations(server), [
        ['set-default-source', 'wa_mic'], ['set-default-source', 'ts_mic'],
    ], 'a reconnected PulseAudio server gets a fresh nudge');
    server.data['source-outputs'] = [];
    await server.reconcile();
    server.data['source-outputs'] = [stream(20, 'chromium', { source: 3 })];
    server.commands.length = 0;
    await server.reconcile();
    assert.strictEqual(mutations(server).length, 2, 'reused stream IDs are not retained forever');
});

test('audio graph and defaults recover after a virtual device disappears', async () => {
    const server = audioServer();
    server.data.sinks.shift();
    server.data.sources.shift();
    server.defaults.sink = 'other';
    server.defaults.source = 'other';
    await server.reconcile();
    const changes = mutations(server);
    assert.strictEqual(changes.filter((args) => args[0] === 'load-module').length, 2);
    assert.deepStrictEqual(changes.slice(-2), [
        ['set-default-sink', 'wa_out'], ['set-default-source', 'ts_mic'],
    ]);
    server.commands.length = 0;
    await server.reconcile();
    assert.deepStrictEqual(mutations(server), []);
});

test('subscription coalesces events, serializes reconciliation and reconnects', async (t) => {
    const children = [];
    let reads = 0;
    let resets = 0;
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    const errors = [];
    const reconciler = {
        reset: () => { resets += 1; },
        reconcile: async () => { if (++reads === 1) await first; },
    };
    const stop = startAudioRouter({
        reconciler, debounceMs: 5, reconnectMs: 5, recoveryMs: 100000,
        logError: (error) => errors.push(error),
        subscribe: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.kill = () => { child.stdout.end(); child.emit('close', 0); };
            children.push(child);
            return child;
        },
    });
    t.after(stop);
    const waitFor = async (predicate) => {
        for (let i = 0; i < 200 && !predicate(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(predicate(), 'router made progress');
    };
    await waitFor(() => reads === 1);
    children[0].stdout.write("Event 'new' on source-output #20\n".repeat(100));
    assert.strictEqual(reads, 1, 'pending work never overlaps');
    release();
    await waitFor(() => reads === 2);
    children[0].stdout.write("Event 'new' on client #25\n".repeat(100));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(reads, 2, 'pactl client connection events are ignored');
    children[0].kill();
    await waitFor(() => children.length === 2 && reads === 3);
    assert.strictEqual(resets, 2);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(children.length, 2, 'stopping never reconnects');
    assert.deepStrictEqual(errors, []);
});
