'use strict';

const assert = require('assert');
const test = require('node:test');
const { tsEscape, tsUnescape, parseTsLine, parseTsRows } = require('../bot/teamspeak/protocol');
const { normalizeContactId, parseContactGroups } = require('../bot/contacts');
const { parseArgs } = require('../bot/util');
const { intFromEnv } = require('../bot/config');

test('ClientQuery escaping round-trips special characters', () => {
    const raw = 'a b/c|d\\e\nf\tg';
    assert.strictEqual(tsEscape(raw), 'a\\sb\\/c\\pd\\\\e\\nf\\tg');
    assert.strictEqual(tsUnescape(tsEscape(raw)), raw);
});

test('ClientQuery rows parse into unescaped key/value objects', () => {
    assert.deepStrictEqual(parseTsLine('cid=1 channel_name=Lobby\\sOne flag'), {
        cid: '1',
        channel_name: 'Lobby One',
    });
    assert.deepStrictEqual(
        parseTsRows(['cid=1 channel_name=A|cid=2 channel_name=B', 'error id=0 msg=ok']),
        [
            { cid: '1', channel_name: 'A' },
            { cid: '2', channel_name: 'B' },
        ],
    );
});

test('phone numbers normalise to WhatsApp contact IDs', () => {
    assert.strictEqual(normalizeContactId('+49 170 1234567'), '491701234567@c.us');
    assert.strictEqual(normalizeContactId('0049-170-1234567'), '491701234567@c.us');
    assert.strictEqual(normalizeContactId('491701234567@c.us'), '491701234567@c.us');
    assert.throws(() => normalizeContactId('123@g.us'), /Group IDs/);
    assert.throws(() => normalizeContactId('12'), /Invalid phone number/);
});

test('contact groups are lower-cased and invalid JSON is ignored', () => {
    const groups = parseContactGroups('{"Support":["+491701234567"]}');
    assert.deepStrictEqual(groups.get('support'), ['491701234567@c.us']);

    const originalError = console.error;
    console.error = () => {};
    try {
        assert.strictEqual(parseContactGroups('{not json').size, 0);
    } finally {
        console.error = originalError;
    }
});

test('command arguments honour quotes', () => {
    assert.deepStrictEqual(parseArgs('call "Team A" +49 \'x y\''), [
        'call',
        'Team A',
        '+49',
        'x y',
    ]);
});

test('integer env settings fall back and clamp', () => {
    const name = 'BRIDGE_TEST_INT_FROM_ENV';
    const previous = process.env[name];
    try {
        delete process.env[name];
        assert.strictEqual(intFromEnv(name, 12, { min: 2, max: 12 }), 12);
        process.env[name] = '50';
        assert.strictEqual(intFromEnv(name, 12, { min: 2, max: 12 }), 12);
        process.env[name] = '1';
        assert.strictEqual(intFromEnv(name, 12, { min: 2, max: 12 }), 2);
        process.env[name] = 'abc';
        assert.strictEqual(intFromEnv(name, 5000, { min: 1000 }), 5000);
    } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    }
});
