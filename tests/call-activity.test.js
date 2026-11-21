'use strict';

const assert = require('assert');
const test = require('node:test');
const { createCallAnnouncementTracker } = require('../bot/whatsapp/call-activity');

const idle = { active: false, callId: null, participantCount: 0 };
const call = (participantCount, callId = 'c1') => ({ active: true, callId, participantCount });

// Feeds the readings in order; a change needs two equal reads to be announced.
function run(readings) {
    const update = createCallAnnouncementTracker();
    const messages = [];
    for (const reading of readings) messages.push(...update(reading));
    return messages;
}

test('a call lifecycle produces generic start, join, leave and end messages', () => {
    assert.deepStrictEqual(
        run([idle, idle, call(1), call(1), call(3), call(3), call(2), call(2), idle, idle]),
        [
            '📞 WhatsApp call started (1 on WhatsApp).',
            '📞 2 people joined the WhatsApp call (3 on WhatsApp).',
            '📞 Someone left the WhatsApp call (2 on WhatsApp).',
            '📞 WhatsApp call ended.',
        ],
    );
});

test('a single deviating read is not announced', () => {
    assert.deepStrictEqual(run([call(2), call(2), call(3), call(2), call(2), call(2)]), [
        '📞 WhatsApp call started (2 on WhatsApp).',
    ]);
});

test('unknown participant counts during a call are ignored', () => {
    assert.deepStrictEqual(
        run([call(2), call(2), call(null), call(null), call(null), call(2), call(2)]),
        ['📞 WhatsApp call started (2 on WhatsApp).'],
    );
});

test('a call that starts without remote participants omits the count', () => {
    assert.deepStrictEqual(run([call(0), call(0), call(1), call(1)]), [
        '📞 WhatsApp call started.',
        '📞 Someone joined the WhatsApp call (1 on WhatsApp).',
    ]);
});

test('a new call ID ends the previous call and starts the next', () => {
    assert.deepStrictEqual(run([call(1, 'a'), call(1, 'a'), call(1, 'b'), call(1, 'b')]), [
        '📞 WhatsApp call started (1 on WhatsApp).',
        '📞 WhatsApp call ended.',
        '📞 WhatsApp call started (1 on WhatsApp).',
    ]);
});

test('messages never contain numbers or IDs from the call', () => {
    const update = createCallAnnouncementTracker();
    const readings = [
        { active: true, callId: '491701234567@c.us-call', participantCount: 1 },
        { active: true, callId: '491701234567@c.us-call', participantCount: 1 },
    ];
    const messages = readings.flatMap((reading) => update(reading));
    assert.strictEqual(messages.length, 1);
    assert.doesNotMatch(messages[0], /4917|@c\.us/);
});
