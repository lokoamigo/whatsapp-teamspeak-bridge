'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPresence, describeRoster } = require('../bot/presence');

function setup() {
    const rosters = { teamspeak: { channel: '1', users: [] }, mumble: { channel: 3, users: [] } };
    const fail = { teamspeak: false, mumble: false };
    const announced = [];
    const privates = [];
    const mk = (name, label) => ({
        label,
        poll: async () => { if (fail[name]) throw new Error('down'); return rosters[name]; },
        sendPrivate: async (user, text) => { privates.push([label, user.name, text]); },
    });
    const presence = createPresence({
        sides: { teamspeak: mk('teamspeak', 'TS'), mumble: mk('mumble', 'Mumble') },
        announce: (target, line) => announced.push([target, line]),
        log: { error: () => {} },
    });
    const u = (key, name) => ({ key, name });
    return { presence, rosters, fail, announced, privates, u };
}

test('the first poll is a silent baseline, later changes are announced to the other side', async () => {
    const { presence, rosters, announced, u } = setup();
    rosters.teamspeak.users = [u('a', 'Alice')];
    await presence.poll('teamspeak');
    assert.deepEqual(announced, []);
    rosters.teamspeak.users = [u('a', 'Alice'), u('b', 'Bob'), u('c', 'Cy')];
    await presence.poll('teamspeak');
    rosters.teamspeak.users = [u('b', 'Bob'), u('c', 'Cy')];
    await presence.poll('teamspeak');
    assert.deepEqual(announced, [['mumble', '[TS] joined: Bob, Cy'], ['mumble', '[TS] left: Alice']]);
});

test('an arrival is told privately who is in the other room', async () => {
    const { presence, rosters, privates, u } = setup();
    await presence.poll('teamspeak');
    rosters.mumble.users = [u(1, 'Mia'), u(2, 'Max')];
    await presence.poll('mumble');
    rosters.teamspeak.users = [u('a', 'Alice')];
    await presence.poll('teamspeak');
    assert.deepEqual(privates, [['TS', 'Alice', 'In the Mumble channel: Mia, Max.']]);
});

test('no private roster is sent while the other side is unknown or empty roster is described', async () => {
    const { presence, rosters, privates, u } = setup();
    await presence.poll('teamspeak');
    rosters.teamspeak.users = [u('a', 'Alice')];
    await presence.poll('teamspeak');
    assert.deepEqual(privates, []);
    assert.equal(describeRoster('Mumble', []), 'Nobody is in the Mumble channel right now.');
});

test('reconnects and bridge channel changes resync silently', async () => {
    const { presence, rosters, fail, announced, u } = setup();
    await presence.poll('mumble');
    fail.mumble = true;
    await presence.poll('mumble');
    fail.mumble = false;
    rosters.mumble.users = [u(1, 'Mia')];
    await presence.poll('mumble'); // baseline after outage
    rosters.mumble = { channel: 4, users: [u(2, 'Max')] };
    await presence.poll('mumble'); // bridge moved
    assert.deepEqual(announced, []);
    rosters.mumble.users = [];
    await presence.poll('mumble');
    assert.deepEqual(announced, [['teamspeak', '[Mumble] left: Max']]);
});

test('long name lists are shortened', () => {
    const { formatNames } = require('../bot/presence');
    const users = Array.from({ length: 9 }, (_, i) => ({ name: `U${i}` }));
    assert.equal(formatNames(users), 'U0, U1, U2, U3, U4, U5 and 3 more');
});

test('private rosters are capped per poll and a failed one does not stop the rest', async () => {
    const sent = [];
    const errors = [];
    let users = [];
    const side = {
        label: 'TS',
        poll: async () => ({ channel: '1', users }),
        sendPrivate: async (user) => {
            if (user.key === 0) throw new Error('flood');
            sent.push(user.key);
        },
    };
    const presence = createPresence({
        sides: { teamspeak: side, mumble: { label: 'Mumble', poll: async () => ({ channel: 1, users: [] }) } },
        announce: () => {},
        log: { error: (message) => errors.push(message) },
    });
    await presence.poll('mumble');
    await presence.poll('teamspeak');
    users = Array.from({ length: 8 }, (_, key) => ({ key, name: `U${key}` }));
    await presence.poll('teamspeak');
    assert.deepEqual(sent, [1, 2, 3, 4]);
    assert.equal(errors.length, 1);
});

test('the TeamSpeak roster keeps only other regular clients in the bridge channel', async () => {
    const { ClientQuery } = require('../bot/teamspeak/client-query');
    const query = new ClientQuery();
    query.command = async (text) => {
        if (text === 'whoami') return ['clid=1 cid=8', 'error id=0 msg=ok'];
        assert.equal(text, 'clientlist -uid');
        return [
            'clid=1 cid=8 client_nickname=Bridge client_type=0 client_unique_identifier=self'
                + '|clid=2 cid=8 client_nickname=Query client_type=1 client_unique_identifier=q'
                + '|clid=3 cid=9 client_nickname=Elsewhere client_type=0 client_unique_identifier=e'
                + '|clid=4 cid=8 client_nickname=Alice\\sA client_type=0 client_unique_identifier=a',
            'error id=0 msg=ok',
        ];
    };
    assert.deepEqual(await query.listChannelRoster(), {
        channel: '8', users: [{ key: 'a', clid: '4', name: 'Alice A' }],
    });
});
