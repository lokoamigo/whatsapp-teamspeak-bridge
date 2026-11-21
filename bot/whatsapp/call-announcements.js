'use strict';

// Posts generic WhatsApp call activity ("someone joined/left") to the voice
// channel chat. The whatsapp-web.js fork has no participant events, so the
// participant count is polled; see call-activity.js for the change detection.

const { CALL_ANNOUNCE_POLL_MS } = require('../config');
const state = require('../state');
const { createCallAnnouncementTracker } = require('./call-activity');
const { getLiveWhatsAppCallStatus } = require('./calls');

function startCallAnnouncements(waClient, { intervalMs = CALL_ANNOUNCE_POLL_MS } = {}) {
    const update = createCallAnnouncementTracker();
    let running = false;
    let lastErrorAt = 0;

    const logError = (message) => {
        const now = Date.now();
        if (now - lastErrorAt > 60000) {
            console.error(message);
            lastErrorAt = now;
        }
    };

    const tick = async () => {
        if (running || !state.ready) return;
        running = true;
        try {
            const messages = update(await getLiveWhatsAppCallStatus(waClient));
            for (const message of messages) {
                console.log(`Call announcement: ${message}`);
                if (!state.voiceChannels) continue;
                await state.voiceChannels.sendChannelMessage(message).catch((error) => {
                    console.error(`Could not post call announcement: ${error.message}`);
                });
            }
        } catch (error) {
            logError(`Call announcement poll failed: ${error.message}`);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(tick, intervalMs);
    timer.unref();
    console.log(`WhatsApp call announcements enabled (poll ${intervalMs} ms).`);
    return () => clearInterval(timer);
}

module.exports = { startCallAnnouncements };
