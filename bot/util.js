'use strict';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slow browser or socket requests must not accumulate on interval ticks.
function startSerialInterval(task, intervalMs, onError) {
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        Promise.resolve().then(task).catch(onError).finally(() => {
            running = false;
        });
    }, intervalMs);
    timer.unref();
    return timer;
}

function parseArgs(input) {
    const args = [];
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    let match;
    while ((match = regex.exec(input)) !== null) {
        args.push((match[1] || match[2] || match[3]).replace(/\\(["'])/g, '$1'));
    }
    return args;
}

module.exports = { sleep, parseArgs, startSerialInterval };
