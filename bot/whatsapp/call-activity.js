'use strict';

// Turns successive WhatsApp call status readings into generic activity
// messages ("someone joined/left"). A change is only reported once it was
// read the same twice in a row, which filters short roster glitches. Messages
// never contain phone numbers or contact names.

const STABLE_READS = 2;
const IDLE = Object.freeze({ active: false, callId: null, count: null });

function onWhatsApp(count) {
    return `${count} on WhatsApp`;
}

function describeChange(from, to) {
    const messages = [];
    const sameCall = from.active && to.active && from.callId === to.callId;

    if (from.active && !sameCall) {
        messages.push('📞 WhatsApp call ended.');
    }
    if (to.active && !sameCall) {
        messages.push(
            to.count > 0
                ? `📞 WhatsApp call started (${onWhatsApp(to.count)}).`
                : '📞 WhatsApp call started.',
        );
    }
    if (sameCall && from.count !== null && to.count !== null && from.count !== to.count) {
        const delta = to.count - from.count;
        const who = Math.abs(delta) === 1 ? 'Someone' : `${Math.abs(delta)} people`;
        const verb = delta > 0 ? 'joined' : 'left';
        messages.push(`📞 ${who} ${verb} the WhatsApp call (${onWhatsApp(to.count)}).`);
    }
    return messages;
}

function sameObservation(left, right) {
    return (
        left.active === right.active &&
        left.callId === right.callId &&
        left.count === right.count
    );
}

// Turns successive call status readings (getLiveWhatsAppCallStatus) into
// announcement messages.
function createCallAnnouncementTracker({ stableReads = STABLE_READS } = {}) {
    let announced = IDLE;
    let candidate = null;
    let reads = 0;

    return function update(status) {
        let observation = status && status.active
            ? {
                  active: true,
                  callId: status.callId || 'unknown',
                  count: Number.isInteger(status.participantCount)
                      ? status.participantCount
                      : null,
              }
            : IDLE;

        // An unknown count during an announced call is a read glitch, not news.
        if (
            observation.active &&
            observation.count === null &&
            announced.active &&
            announced.callId === observation.callId
        ) {
            observation = announced;
        }

        if (candidate && sameObservation(candidate, observation)) {
            reads += 1;
        } else {
            candidate = observation;
            reads = 1;
        }
        if (reads < stableReads || sameObservation(candidate, announced)) return [];

        const messages = describeChange(announced, candidate);
        announced = candidate;
        return messages;
    };
}

module.exports = { createCallAnnouncementTracker, describeChange };
