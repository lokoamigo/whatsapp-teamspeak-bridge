'use strict';

// TeamSpeak ClientQuery wire format: escaping and key=value row parsing.

function tsEscape(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\//g, '\\/')
        .replace(/\|/g, '\\p')
        .replace(/\x07/g, '\\a')
        .replace(/\x08/g, '\\b')
        .replace(/\f/g, '\\f')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\x0b/g, '\\v')
        .replace(/ /g, '\\s');
}

function tsUnescape(value) {
    return String(value).replace(/\\([\\\/psabfnrtv])/g, (_, code) => {
        switch (code) {
            case '\\':
                return '\\';
            case '/':
                return '/';
            case 'p':
                return '|';
            case 's':
                return ' ';
            case 'a':
                return '\x07';
            case 'b':
                return '\b';
            case 'f':
                return '\f';
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case 'v':
                return '\x0b';
            default:
                return code;
        }
    });
}

function parseTsLine(line) {
    const fields = {};
    for (const token of line.trim().split(' ')) {
        const index = token.indexOf('=');
        if (index === -1) continue;
        fields[token.slice(0, index)] = tsUnescape(token.slice(index + 1));
    }
    return fields;
}

function parseTsRows(lines) {
    const rows = [];
    for (const line of lines) {
        if (!line || line.startsWith('error ')) continue;
        for (const row of line.split('|')) {
            if (row.trim()) rows.push(parseTsLine(row));
        }
    }
    return rows;
}

module.exports = { tsEscape, tsUnescape, parseTsLine, parseTsRows };
