'use strict';

// Versioned local JSON API (`/api/v1/...`).

const http = require('http');
const { API_HOST, API_PORT, BRIDGE_VERSION } = require('../config');
const state = require('../state');
const { getLiveWhatsAppCallStatus } = require('../whatsapp/calls');

function sendApiJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

function createApiServer(waClient) {
    // Keep endpoints in a registry so additional API versions and resources can
    // be added without turning the bot's main flow into a routing switch.
    const routes = new Map([
        [
            'GET /api/v1/health',
            async () => ({
                statusCode: 200,
                body: {
                    ready: state.ready,
                    awaitingQr: state.awaitingQr,
                    version: BRIDGE_VERSION,
                },
            }),
        ],
        [
            'GET /api/v1/calls/active/participants',
            async () => {
                const callStatus = await getLiveWhatsAppCallStatus(waClient);
                return {
                    statusCode: 200,
                    body: callStatus,
                };
            },
        ],
    ]);

    const server = http.createServer(async (request, response) => {
        const method = request.method || 'GET';
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        const handler = routes.get(`${method} ${pathname}`);

        if (!handler) {
            sendApiJson(response, 404, { error: 'Not found.' });
            return;
        }

        try {
            const result = await handler();
            sendApiJson(response, result.statusCode, result.body);
        } catch (error) {
            console.error(`Bridge API ${method} ${pathname} failed: ${error.message}`);
            sendApiJson(response, 503, {
                error: 'WhatsApp call status is temporarily unavailable.',
            });
        }
    });

    server.listen(API_PORT, API_HOST, () => {
        console.log(`Bridge API listening on http://${API_HOST}:${API_PORT}`);
    });
    server.on('error', (error) => {
        console.error(`Bridge API server error: ${error.message}`);
    });

    return server;
}

module.exports = { createApiServer };
