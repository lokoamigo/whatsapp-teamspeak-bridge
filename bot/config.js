'use strict';

// All environment-driven settings of the bridge bot, parsed once at startup.

const { version: BRIDGE_VERSION } = require('../package.json');

// Integer setting: unset, empty, non-numeric or 0 values fall back to the
// default, then the result is clamped to [min, max].
function intFromEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const parsed =
        Number.parseInt(process.env[name] || String(fallback), 10) || fallback;
    return Math.min(max, Math.max(min, parsed));
}

function listFromEnv(name, fallback = '') {
    return (process.env[name] || fallback)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

const TS_HOST = process.env.TS3_CLIENTQUERY_HOST || '127.0.0.1';
const TS_PORT = Number.parseInt(process.env.TS3_CLIENTQUERY_PORT || '25639', 10);
const TS_API_KEY = (process.env.TS3_CLIENTQUERY_API_KEY || '').trim();
const TS3_URI = process.env.TS3_URI || '';
const VOICE_BACKEND = process.env.BRIDGE_VOICE_BACKEND || 'teamspeak';
const COMBINED_VOICE = VOICE_BACKEND === 'teamspeak-mumble';
const VOICE_BACKEND_LABEL = VOICE_BACKEND === 'mumble' ? 'Mumble' : 'TeamSpeak';
const MUMBLE_URI = process.env.MUMBLE_URI || '';
const MUMBLE_CLIENT = COMBINED_VOICE ? 'native' : process.env.BRIDGE_MUMBLE_CLIENT || 'gui';
const MUMBLE_NATIVE_SOCKET = process.env.MUMBLE_NATIVE_SOCKET || '/tmp/runtime-bridge/mumble-native.sock';
const MUMBLE_BOT_URI = process.env.MUMBLE_BOT_URI || '';
const MUMBLE_BOT_DATA_DIR = process.env.MUMBLE_BOT_DATA_DIR || '/data/mumble/bridge-bot';
const CHROMIUM_EXECUTABLE =
    process.env.WWEBJS_CHROMIUM_EXECUTABLE || '/usr/bin/chromium';
const CHROMIUM_PROFILE = process.env.WWEBJS_CHROMIUM_PROFILE || '/data/chromium';
const DISPLAY_WIDTH = process.env.DISPLAY_WIDTH || '1440';
const DISPLAY_HEIGHT = process.env.DISPLAY_HEIGHT || '900';
const COMMAND_PREFIX = process.env.BRIDGE_COMMAND_PREFIX || '!wa';
const WHATSAPP_INVITE_COMMAND =
    process.env.BRIDGE_WHATSAPP_INVITE_COMMAND || '!invite';
const FORCE_WEB_CALLING =
    (process.env.BRIDGE_FORCE_WEB_CALLING || 'true').trim().toLowerCase() ===
    'true';

const WHATSAPP_PULSE_SOURCE = process.env.BRIDGE_WHATSAPP_PULSE_SOURCE || 'ts_mic';
const WHATSAPP_PULSE_SOURCE_NUDGE =
    process.env.BRIDGE_WHATSAPP_PULSE_SOURCE_NUDGE || 'wa_mic';
const WHATSAPP_CALL_MIC_MENU_TARGET =
    process.env.BRIDGE_WHATSAPP_CALL_MIC_MENU_TARGET ||
    'TeamSpeak_to_WhatsApp_Microphone';
const WHATSAPP_CALL_MIC_MENU_NUDGE =
    process.env.BRIDGE_WHATSAPP_CALL_MIC_MENU_NUDGE || 'Default';
const WHATSAPP_CALL_MIC_MENU_DELAY_MS = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_DELAY_MS',
    2000,
    { min: 0 },
);
const WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS',
    3000,
    { min: 0 },
);
const WHATSAPP_CALL_MIC_MENU_OPEN_DELAY_MS = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_OPEN_DELAY_MS',
    500,
    { min: 0 },
);
const WHATSAPP_CALL_MIC_MENU_RETRIES = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_RETRIES',
    3,
    { min: 1 },
);
const WHATSAPP_CALL_MIC_MENU_RETRY_DELAY_MS = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_RETRY_DELAY_MS',
    3000,
    { min: 0 },
);
const WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS = intFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS',
    3000,
    { min: 0 },
);
const WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS = listFromEnv(
    'BRIDGE_WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS',
    '3000,10000,20000',
)
    .map((value) => Math.max(0, Number.parseInt(value, 10) || 0))
    .filter((value, index, values) => value > 0 && values.indexOf(value) === index)
    .sort((left, right) => left - right);

const API_HOST = process.env.BRIDGE_API_HOST || '0.0.0.0';
const API_PORT = intFromEnv('BRIDGE_API_PORT', 8080, { min: 1 });

const WHATSAPP_SWITCH_CHANNEL_COMMAND = '!switchchannel';
const WHATSAPP_SWITCH_CHANNEL_COMMAND_TYPO = '!switchcahnnel';
const CHANNEL_POLL_MAX_OPTIONS = intFromEnv(
    'BRIDGE_WHATSAPP_CHANNEL_POLL_MAX_OPTIONS',
    12,
    { min: 2, max: 12 },
);
const SHOW_MORE_CHANNELS_OPTION = 'show more channels';
const AUTO_ACCEPT_POLL_MS = intFromEnv('BRIDGE_AUTO_ACCEPT_POLL_MS', 5000, {
    min: 1000,
});

// Generic join/leave messages for the WhatsApp call in the voice channel chat.
// Combined mode only: copy channel chat between the TeamSpeak and Mumble rooms.
const CHAT_RELAY =
    COMBINED_VOICE && (process.env.BRIDGE_CHAT_RELAY || 'true').trim().toLowerCase() !== 'false';
const CALL_ANNOUNCEMENTS =
    (process.env.BRIDGE_CALL_ANNOUNCEMENTS || 'true').trim().toLowerCase() === 'true';
const CALL_ANNOUNCE_POLL_MS = intFromEnv('BRIDGE_CALL_ANNOUNCE_POLL_MS', 3000, {
    min: 1000,
});

const COMMANDER_UIDS = new Set(listFromEnv('BRIDGE_COMMANDER_UIDS'));
const CONTACT_GROUPS_JSON = process.env.BRIDGE_CONTACT_GROUPS || '{}';

module.exports = {
    intFromEnv,
    listFromEnv,
    BRIDGE_VERSION,
    TS_HOST,
    TS_PORT,
    TS_API_KEY,
    TS3_URI,
    VOICE_BACKEND,
    COMBINED_VOICE,
    VOICE_BACKEND_LABEL,
    MUMBLE_URI,
    MUMBLE_CLIENT,
    MUMBLE_NATIVE_SOCKET,
    MUMBLE_BOT_URI,
    MUMBLE_BOT_DATA_DIR,
    CHROMIUM_EXECUTABLE,
    CHROMIUM_PROFILE,
    DISPLAY_WIDTH,
    DISPLAY_HEIGHT,
    COMMAND_PREFIX,
    WHATSAPP_INVITE_COMMAND,
    FORCE_WEB_CALLING,
    WHATSAPP_PULSE_SOURCE,
    WHATSAPP_PULSE_SOURCE_NUDGE,
    WHATSAPP_CALL_MIC_MENU_TARGET,
    WHATSAPP_CALL_MIC_MENU_NUDGE,
    WHATSAPP_CALL_MIC_MENU_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_OPEN_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_RETRIES,
    WHATSAPP_CALL_MIC_MENU_RETRY_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS,
    WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS,
    API_HOST,
    API_PORT,
    WHATSAPP_SWITCH_CHANNEL_COMMAND,
    WHATSAPP_SWITCH_CHANNEL_COMMAND_TYPO,
    CHANNEL_POLL_MAX_OPTIONS,
    SHOW_MORE_CHANNELS_OPTION,
    AUTO_ACCEPT_POLL_MS,
    CALL_ANNOUNCEMENTS,
    CHAT_RELAY,
    CALL_ANNOUNCE_POLL_MS,
    COMMANDER_UIDS,
    CONTACT_GROUPS_JSON,
};
