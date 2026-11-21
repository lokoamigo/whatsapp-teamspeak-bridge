'use strict';

// PulseAudio helpers for the WhatsApp microphone (ts_mic) routing.

const { execFile } = require('child_process');
const {
    WHATSAPP_PULSE_SOURCE,
    WHATSAPP_PULSE_SOURCE_NUDGE,
} = require('../config');
const { sleep } = require('../util');

function runPactl(args) {
    return new Promise((resolve, reject) => {
        execFile('pactl', args, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

async function refreshWhatsAppMicrophone(reason) {
    try {
        await runPactl(['set-default-source', WHATSAPP_PULSE_SOURCE_NUDGE]);
        await sleep(200);
        await runPactl(['set-default-source', WHATSAPP_PULSE_SOURCE]);
        console.log(
            `Refreshed WhatsApp microphone default after ${reason}: ${WHATSAPP_PULSE_SOURCE}`,
        );
    } catch (error) {
        console.log(
            `Could not refresh WhatsApp microphone after ${reason}: ${error.message}`,
        );
    }
}

async function hasWhatsAppChromiumCaptureStream() {
    try {
        const [outputs, sources] = await Promise.all([
            runPactl(['list', 'source-outputs']),
            runPactl(['list', 'short', 'sources']),
        ]);
        const sourceIndex = sources
            .split('\n')
            .map((line) => line.split('\t'))
            .find((fields) => fields[1] === WHATSAPP_PULSE_SOURCE)?.[0];

        return outputs
            .split(/\n(?=Source Output #)/)
            .some((block) => {
                const isChromiumRecordStream =
                    /application\.process\.binary = "chromium"/.test(block) &&
                    /media\.name = "RecordStream"/.test(block);
                if (!isChromiumRecordStream) return false;
                return !sourceIndex || block.includes(`\n\tSource: ${sourceIndex}\n`);
            });
    } catch (error) {
        console.log(`Could not inspect WhatsApp microphone capture stream: ${error.message}`);
        return false;
    }
}

module.exports = {
    runPactl,
    refreshWhatsAppMicrophone,
    hasWhatsAppChromiumCaptureStream,
};
