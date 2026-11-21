'use strict';

// Compatibility shim: wraps WhatsApp Web's internal poll-vote table so votes
// reach the bot even when the fork's vote_update event lacks the parent
// message ID. Runs only inside the bot-owned browser session.

const { handleWhatsAppPollVoteBulkUpsert } = require('./channel-polls');

async function attachWhatsAppPollVoteBridge(client) {
    if (!client.pupPage || client.pupPage.isClosed()) return;

    if (typeof client.pupPage.exposeFunction === 'function') {
        try {
            await client.pupPage.exposeFunction('__bridgePollVoteBulkUpsert', (event) => {
                handleWhatsAppPollVoteBulkUpsert(client, event).catch((error) => {
                    console.error(
                        `WhatsApp poll bulk-upsert handler failed: ${error.message}`,
                    );
                });
            });
        } catch (error) {
            if (!/already|exist/i.test(error.message)) throw error;
        }
    }

    const bridgeStatus = await client.pupPage.evaluate(() => {
        const result = {
            wwebjs: typeof window.WWebJS !== 'undefined',
            hookAttached: false,
            modulePresent: false,
        };

        let pollVoteModule = null;
        try {
            pollVoteModule = window.require('WAWebAddonPollVoteTableMode');
            result.modulePresent = true;
        } catch (error) {
            result.error = error.message;
            return result;
        }

        const mode = pollVoteModule?.pollVoteTableMode;
        if (
            mode &&
            typeof mode.bulkUpsert === 'function' &&
            !mode.bulkUpsert.__bridgePollVoteBridgeWrapped
        ) {
            const original = mode.bulkUpsert;
            mode.bulkUpsert = function (...args) {
                const keyValues = (key) => {
                    if (!key) return [];
                    const values = [
                        key._serialized,
                        key.id,
                        typeof key.toString === 'function' ? key.toString() : null,
                    ].filter(Boolean);
                    return Array.from(new Set(values.map(String)));
                };
                const jidValue = (jid) => {
                    return jid?._serialized || jid?.user || jid?.server || null;
                };
                const selectedIds = (value) => {
                    if (!value) return [];
                    if (value instanceof Uint8Array) return Array.from(value);
                    if (Array.isArray(value)) return value;
                    if (typeof value === 'object') {
                        return Object.keys(value)
                            .sort((left, right) => Number(left) - Number(right))
                            .map((key) => value[key]);
                    }
                    return [];
                };
                const events = (Array.isArray(args[0]) ? args[0] : []).map((vote) => ({
                    id: keyValues(vote.id),
                    parentKeys: [
                        ...keyValues(vote.pollUpdateParentKey),
                        ...keyValues(vote.parentMsgKey),
                    ],
                    chatIds: [
                        jidValue(vote.from),
                        jidValue(vote.to),
                    ].filter(Boolean),
                    voter:
                        jidValue(vote.author) ||
                        jidValue(vote.from) ||
                        vote.senderUserJid ||
                        null,
                    selectedOptionLocalIds: selectedIds(vote.selectedOptionLocalIds),
                    lastSuccessfulSelectedOptionLocalIds: selectedIds(
                        vote.lastSuccessfulSelectedOptionLocalIds,
                    ),
                    senderTimestampMs: vote.senderTimestampMs || vote.t || null,
                }));
                try {
                    for (const event of events) {
                        window.__bridgePollVoteBulkUpsert(event);
                    }
                } catch (error) {
                    console.error(`Bridge poll vote handler failed: ${error.message}`);
                }
                return original.apply(this, args);
            };
            mode.bulkUpsert.__bridgePollVoteBridgeWrapped = true;
            result.hookAttached = true;
        }

        return result;
    });

    console.log(`WhatsApp poll vote bridge attached: ${JSON.stringify(bridgeStatus)}`);
}

module.exports = { attachWhatsAppPollVoteBridge };
