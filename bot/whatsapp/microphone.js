'use strict';

// Keeps WhatsApp Web's in-call microphone pointed at the TeamSpeak/Mumble
// audio source by driving the call's audio-settings menu.

const {
    WHATSAPP_CALL_MIC_MENU_TARGET,
    WHATSAPP_CALL_MIC_MENU_NUDGE,
    WHATSAPP_CALL_MIC_MENU_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_OPEN_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_RETRIES,
    WHATSAPP_CALL_MIC_MENU_RETRY_DELAY_MS,
    WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS,
    WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS,
} = require('../config');
const state = require('../state');
const { sleep } = require('../util');
const {
    refreshWhatsAppMicrophone,
    hasWhatsAppChromiumCaptureStream,
} = require('../audio/pulse');

async function grantWhatsAppMicrophonePermission(client, reason) {
    if (!client.pupPage || client.pupPage.isClosed()) return;

    try {
        const browserContext = client.pupPage.browserContext?.();
        if (typeof browserContext?.overridePermissions === 'function') {
            await browserContext.overridePermissions('https://web.whatsapp.com', [
                'microphone',
                'notifications',
            ]);
        }
    } catch (error) {
        console.log(
            `Could not pre-grant WhatsApp microphone permission after ${reason}: ${error.message}`,
        );
    }
}

async function findWhatsAppCallAudioMenuItem(page, label) {
    const handle = await page.evaluateHandle((targetLabel) => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const wanted = normalize(targetLabel);
        const items = Array.from(
            document.querySelectorAll('[role="menuitemcheckbox"]'),
        );
        return (
            items.find((element) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                if (
                    rect.width <= 0 ||
                    rect.height <= 0 ||
                    style.visibility === 'hidden' ||
                    style.display === 'none'
                ) {
                    return false;
                }

                const aria = normalize(element.getAttribute('aria-label'));
                const text = normalize(element.innerText || element.textContent);
                return aria === wanted || text === wanted;
            }) || null
        );
    }, label);

    const element = handle.asElement();
    if (element) return element;
    await handle.dispose();
    return null;
}

async function hasWhatsAppCallAudioMenuItem(page, label) {
    const element = await findWhatsAppCallAudioMenuItem(page, label);
    if (!element) return false;
    await element.dispose();
    return true;
}

async function clickWhatsAppCallAudioMenuItem(page, label) {
    const element = await findWhatsAppCallAudioMenuItem(page, label);
    if (!element) return false;

    try {
        const box = await element.boundingBox();
        if (!box) return false;

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
    } finally {
        await element.dispose();
    }
}

async function hasWhatsAppCallAudioMenu(page) {
    return page.evaluate(() => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        return Array.from(
            document.querySelectorAll('[role="menuitemcheckbox"]'),
        ).some((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                style.visibility === 'hidden' ||
                style.display === 'none'
            ) {
                return false;
            }

            const aria = normalize(element.getAttribute('aria-label'));
            const text = normalize(element.innerText || element.textContent);
            return /default|microphone|mikrofon|teamspeak|whatsapp/i.test(aria || text);
        });
    });
}

async function listWhatsAppCallAudioMenuItems(page) {
    return page.evaluate(() => {
        const normalize = (value) => String(value || '').trim();
        return Array.from(
            document.querySelectorAll('[role="menuitemcheckbox"]'),
        )
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.visibility !== 'hidden' &&
                    style.display !== 'none'
                );
            })
            .map((element) =>
                normalize(
                    element.getAttribute('aria-label') ||
                        element.innerText ||
                        element.textContent,
                ),
            )
            .filter((label) =>
                /default|microphone|mikrofon|teamspeak|whatsapp/i.test(label),
            );
    });
}

async function openWhatsAppCallAudioMenu(page, expectedLabel = null) {
    const selector = '[data-testid="audio-settings"]';
    await page.waitForSelector(selector, { timeout: 10000, visible: true });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (
            expectedLabel
                ? await hasWhatsAppCallAudioMenuItem(page, expectedLabel)
                : await hasWhatsAppCallAudioMenu(page)
        ) {
            return;
        }

        const button = await page.$(selector);
        const box = await button?.boundingBox();
        if (!box) throw new Error('audio settings button is not clickable');

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await button.dispose();
        await sleep(WHATSAPP_CALL_MIC_MENU_OPEN_DELAY_MS);

        if (
            expectedLabel
                ? await hasWhatsAppCallAudioMenuItem(page, expectedLabel)
                : await hasWhatsAppCallAudioMenu(page)
        ) {
            return;
        }

        await page.keyboard.press('Escape').catch(() => {});
        await sleep(250);
    }

    throw new Error(
        expectedLabel
            ? `microphone menu item not visible after opening: ${expectedLabel}`
            : 'microphone menu did not open',
    );
}

async function selectWhatsAppCallMicrophone(client, reason) {
    if (!client.pupPage || client.pupPage.isClosed()) return;

    try {
        await openWhatsAppCallAudioMenu(client.pupPage);
        const nudged = await clickWhatsAppCallAudioMenuItem(
            client.pupPage,
            WHATSAPP_CALL_MIC_MENU_NUDGE,
        );

        if (!nudged) {
            const items = await listWhatsAppCallAudioMenuItems(client.pupPage);
            console.log(
                `WhatsApp call microphone nudge item not visible after ${reason}: ` +
                    `${WHATSAPP_CALL_MIC_MENU_NUDGE}; visible=${items.join('|') || 'none'}`,
            );
        }

        await sleep(WHATSAPP_CALL_MIC_MENU_DELAY_MS);

        await openWhatsAppCallAudioMenu(
            client.pupPage,
            WHATSAPP_CALL_MIC_MENU_TARGET,
        );
        const selected = await clickWhatsAppCallAudioMenuItem(
            client.pupPage,
            WHATSAPP_CALL_MIC_MENU_TARGET,
        );

        if (!selected) {
            throw new Error(
                `microphone menu item not found: ${WHATSAPP_CALL_MIC_MENU_TARGET}`,
            );
        }

        console.log(
            `Selected WhatsApp call microphone after ${reason}: ` +
                `${nudged ? `${WHATSAPP_CALL_MIC_MENU_NUDGE} -> ` : ''}` +
                WHATSAPP_CALL_MIC_MENU_TARGET +
                ` delayMs=${WHATSAPP_CALL_MIC_MENU_DELAY_MS} ` +
                `verifyDelayMs=${WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS}`,
        );
    } catch (error) {
        console.log(
            `Could not select WhatsApp call microphone after ${reason}: ${error.message}`,
        );
    }
}

async function ensureWhatsAppCallMicrophone(client, reason, options = {}) {
    const initialDelayMs =
        options.initialDelayMs === undefined
            ? WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS
            : Math.max(0, options.initialDelayMs);

    if (initialDelayMs > 0) await sleep(initialDelayMs);

    for (let attempt = 1; attempt <= WHATSAPP_CALL_MIC_MENU_RETRIES; attempt += 1) {
        if (await hasWhatsAppChromiumCaptureStream()) {
            console.log(
                `WhatsApp call microphone capture already active after ${reason}.`,
            );
            return;
        }

        await selectWhatsAppCallMicrophone(
            client,
            `${reason} attempt=${attempt}/${WHATSAPP_CALL_MIC_MENU_RETRIES}`,
        );
        await sleep(WHATSAPP_CALL_MIC_MENU_VERIFY_DELAY_MS);

        if (await hasWhatsAppChromiumCaptureStream()) {
            console.log(
                `WhatsApp call microphone capture active after ${reason} attempt=${attempt}.`,
            );
            return;
        }

        if (attempt < WHATSAPP_CALL_MIC_MENU_RETRIES) {
            await sleep(WHATSAPP_CALL_MIC_MENU_RETRY_DELAY_MS);
        }
    }

    console.log(
        `WhatsApp call microphone capture still missing after ${reason} ` +
            `retries=${WHATSAPP_CALL_MIC_MENU_RETRIES}.`,
    );
}

function scheduleWhatsAppCallMicrophoneStabilization(client, reason) {
    const runId = ++state.micStabilizationRunId;
    const delays = WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS.length
        ? WHATSAPP_CALL_MIC_STABILIZE_DELAYS_MS
        : [WHATSAPP_CALL_MIC_MENU_INITIAL_DELAY_MS];

    console.log(
        `Scheduled WhatsApp call microphone stabilization after ${reason}: ` +
            `${delays.join(',')} ms`,
    );

    (async () => {
        let elapsed = 0;
        for (let index = 0; index < delays.length; index += 1) {
            const delay = delays[index];
            await sleep(Math.max(0, delay - elapsed));
            elapsed = delay;

            if (runId !== state.micStabilizationRunId) return;

            await refreshWhatsAppMicrophone(`${reason} stabilize=${index + 1}`);
            await ensureWhatsAppCallMicrophone(
                client,
                `${reason} stabilize=${index + 1}/${delays.length}`,
                { initialDelayMs: 0 },
            );

            if (await hasWhatsAppChromiumCaptureStream()) return;
        }
    })().catch((error) => {
        console.log(
            `WhatsApp call microphone stabilization failed after ${reason}: ${error.message}`,
        );
    });
}

module.exports = {
    grantWhatsAppMicrophonePermission,
    ensureWhatsAppCallMicrophone,
    scheduleWhatsAppCallMicrophoneStabilization,
};
