'use strict';

const assert = require('assert');
const test = require('node:test');
const { RecentSet } = require('../bot/recent-set');
const { startSerialInterval } = require('../bot/util');

test('call duplicate suppression retains recent IDs with a fixed capacity', () => {
    const ids = new RecentSet(3);
    ids.add('a').add('b').add('c').add('a').add('d');
    assert.deepStrictEqual([...ids], ['c', 'a', 'd']);
    assert.strictEqual(ids.has('b'), false);
    for (let i = 0; i < 10000; i++) ids.add(String(i));
    assert.strictEqual(ids.size, 3);
    assert.strictEqual(ids.has('9999'), true);
});

test('slow polling skips overlapping ticks and continues after a failure', async (t) => {
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let failed;
    const errorSeen = new Promise((resolve) => { failed = resolve; });
    let finish;
    const recovered = new Promise((resolve) => { finish = resolve; });
    const timer = startSerialInterval(async () => {
        calls += 1;
        if (calls === 1) await pending;
        else if (calls === 2) throw new Error('temporary failure');
        else finish();
    }, 5, failed);
    t.after(() => clearInterval(timer));
    const deadline = setTimeout(() => finish(), 1000);
    t.after(() => clearTimeout(deadline));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(calls, 1);
    release();
    assert.match((await errorSeen).message, /temporary failure/);
    await recovered;
    assert.ok(calls >= 3);
});
