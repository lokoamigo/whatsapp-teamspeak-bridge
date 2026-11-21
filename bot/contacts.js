'use strict';

const { CONTACT_GROUPS_JSON } = require('./config');

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

const CONTACT_GROUPS = parseContactGroups(CONTACT_GROUPS_JSON);

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

module.exports = {
    normalizeContactId,
    parseContactGroups,
    resolveCallTargets,
    contactGroupsText,
};
