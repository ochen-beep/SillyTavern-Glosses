// @ts-check
/**
 * Auto-generate gate regression tests.
 *
 * User report (seen on an older build): with Settings → Behavior →
 * "Auto-generate on new messages" OFF, footnote generation still fired from
 * time to time. The ONLY automatic trigger in the codebase is
 * events.js#autoGenerateIfConfigured (every other generateFootnotes /
 * targeted call site is a user-initiated button or slash command), so these
 * tests pin every automatic entry point behind S().autoGenerate === false:
 *
 *   - CHARACTER_MESSAGE_RENDERED on a never-glossed message (the plain
 *     "nothing stored → auto-generate" fall-through);
 *   - MESSAGE_SWIPED onto a variant holding a FOREIGN payload clone (rebind
 *     clears it and falls through to auto-generation);
 *   - MESSAGE_UPDATED with a foreign clone (the edit-path fall-through).
 *
 * The last test is the control: the SAME render path with autoGenerate ON
 * must reach the API exactly once — proving the zeroes above are the gate
 * working, not a broken test setup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { makeMessage, resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import {
    PAYLOAD_KEY, stampPayload,
} from '../src/domain/footnote-payload.js';
import { getVariantFootnotes } from '../src/cache.js';
import { bindEvents, unbindEvents } from '../src/events.js';
import {
    _testClearApiOverride,
    _testSetApiOverride,
} from '../src/generator.js';

const TEXT_A = 'Она вошла в серебряный лес, где свет луны ломался о ветви.';
const TEXT_B = 'Серебряный лес кончился; впереди лежала пустошь, поросшая вереском.';
const FNS_A = [{ index: 1, anchor: 'серебряный лес', text: '¹ серебряный лес — note for variant A' }];

function baseSettings(autoGenerate) {
    return {
        enabled: true,
        autoGenerate,
        soundEnabled: false,
        // profile + a selected profile is the minimal configuration
        // checkSourceConfigured accepts (so the gate — not the config probe —
        // is what decides the outcome in these tests).
        source: 'profile',
        selectedProfile: 'p1',
    };
}

/** Handlers map + ctx for bindEvents, mirroring events-swipe-deleted.test.mjs. */
function setup({ settings, chat }) {
    const handlers = new Map();
    resetCtx({
        chat,
        chatId: 'auto-gate',
        chatMetadata: {},
        extensionSettings: { Glosses: settings },
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_UPDATED: 'MESSAGE_UPDATED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
        },
        eventSource: {
            on: (ev, fn) => {
                if (!handlers.has(ev)) handlers.set(ev, []);
                handlers.get(ev).push(fn);
            },
            removeListener: (ev, fn) => {
                const list = handlers.get(ev) || [];
                const i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            },
        },
    });
    loadSettings();
    bindEvents();
    return handlers;
}

/**
 * The event handlers are fire-and-forget (bg) since the ST-pipeline fix, so
 * awaiting the handler call itself does not await the present → auto-generate
 * chain. Lettle the microtask/macrotask chain (config probe, prompt load,
 * API override) settle before asserting.
 */
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

/** Message whose swipe 1 slot holds an inherited clone of swipe 0's payload. */
function makeTransplantedMessage() {
    const msg = makeMessage({ swipes: [TEXT_A, TEXT_B], swipe_id: 1 });
    const payload = stampPayload(msg, 0, FNS_A);
    msg.swipe_info[0].extra[PAYLOAD_KEY] = payload;
    // What ST does at generation end: the live extra (payload of variant 0)
    // is cloned into the NEW swipe slot.
    msg.swipe_info[1].extra[PAYLOAD_KEY] = structuredClone(payload);
    msg.extra = structuredClone(msg.swipe_info[1].extra);
    return msg;
}

async function withApiCounter(fn) {
    let calls = 0;
    _testSetApiOverride(async () => {
        calls++;
        return JSON.stringify({ footnotes: [
            { anchor: 'серебряный лес', text: '¹ серебряный лес — gloss.' },
            { anchor: 'луны', text: '² луны — gloss.' },
        ] });
    });
    try {
        await fn();
        return calls;
    } finally {
        _testClearApiOverride();
    }
}

// ── the default itself ──

test('fresh install: autoGenerate defaults to OFF (opt-in)', () => {
    unbindEvents();
    // No persisted Glosses blob at all — what the first enable sees.
    resetCtx({
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
    });
    loadSettings();
    assert.equal(state.settings.autoGenerate, false,
        'a fresh install must not auto-spend the user’s API quota');
});

test('persisted choice survives: explicit autoGenerate true/false is kept on load', () => {
    unbindEvents();
    for (const persisted of [true, false]) {
        resetCtx({
            chat: [],
            chatMetadata: {},
            extensionSettings: { Glosses: { autoGenerate: persisted } },
        });
        loadSettings();
        assert.equal(state.settings.autoGenerate, persisted,
            'loadSettings must keep the user’s explicit toggle value');
    }
});

test('autoGenerate off: rendered message without a payload does not generate', async () => {
    unbindEvents();
    state.configWarned = false;
    const handlers = setup({
        settings: baseSettings(false),
        chat: [makeMessage({ mes: TEXT_A })],
    });
    try {
        const calls = await withApiCounter(async () => {
            await Promise.all((handlers.get('CHARACTER_MESSAGE_RENDERED') || []).map(fn => fn('0')));
            await settle();
        });
        assert.equal(calls, 0, 'no API call may fire with autoGenerate off');
        assert.equal(getVariantFootnotes('0', 0), null, 'no payload may be created');
    } finally {
        unbindEvents();
    }
});

test('autoGenerate off: swipe onto a foreign-clone variant does not generate', async () => {
    unbindEvents();
    state.configWarned = false;
    const msg = makeTransplantedMessage();
    const handlers = setup({
        settings: baseSettings(false),
        chat: [msg],
    });
    try {
        const calls = await withApiCounter(async () => {
            await Promise.all((handlers.get('MESSAGE_SWIPED') || []).map(fn => fn('0')));
            await settle();
        });
        assert.equal(calls, 0, 'no API call may fire with autoGenerate off');
        assert.equal(msg.swipe_info[1].extra[PAYLOAD_KEY], undefined, 'foreign clone is still cleared');
    } finally {
        unbindEvents();
    }
});

test('autoGenerate off: MESSAGE_UPDATED foreign clone does not generate', async () => {
    unbindEvents();
    state.configWarned = false;
    const msg = makeTransplantedMessage();
    const handlers = setup({
        settings: baseSettings(false),
        chat: [msg],
    });
    try {
        const calls = await withApiCounter(async () => {
            await Promise.all((handlers.get('MESSAGE_UPDATED') || []).map(fn => fn('0')));
            await settle();
        });
        assert.equal(calls, 0, 'no API call may fire with autoGenerate off');
    } finally {
        unbindEvents();
    }
});

test('control: autoGenerate on — the same render path generates exactly once', async () => {
    unbindEvents();
    state.configWarned = false;
    const handlers = setup({
        settings: baseSettings(true),
        chat: [makeMessage({ mes: TEXT_A })],
    });
    try {
        const calls = await withApiCounter(async () => {
            await Promise.all((handlers.get('CHARACTER_MESSAGE_RENDERED') || []).map(fn => fn('0')));
            await settle();
        });
        assert.equal(calls, 1, 'the gated path is otherwise live: one API call');
        assert.ok(getVariantFootnotes('0', 0)?.length, 'payload persisted');
    } finally {
        unbindEvents();
    }
});
