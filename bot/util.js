'use strict';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

module.exports = { sleep, parseArgs };
