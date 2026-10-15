// @ts-check
/**
 * Auto-generate surface audit — the full trigger matrix.
 *
 * The extension may only spend an API call on its own when
 * Settings → Behavior → "Auto-generate on new messages" is ON. These tests
 * walk EVERY ST event Glosses subscribes to against EVERY message state that
 * matters and assert the API is never touched while the toggle is off.
 *
 * The last tests pin the toggle-off-mid-flight contract: flipping the toggle
 * aborts in-flight AUTO runs (their results never commit), while runs the
 * user started by hand are unaffected and manual generation stays ungated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';

// The shared stub covers what pure modules touch at eval time; the EVENT
// storm below also drives renderer helpers that reach for these browser APIs
// at CALL time (restoreHighlightsAll → lazy injector, edit fallback → rAF).
globalThis.IntersectionObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
globalThis.MutationObserver ||= class {
    observe() {}
    disconnect() {}
};
globalThis.requestAnimationFrame ||= ((fn) => setTimeout(fn, 0));
globalThis.cancelAnimationFrame ||= ((id) => clearTimeout(id));
// closePopup() detaches document listeners unconditionally (sync throw in a
// stub without them — and sync throws escape the storm's promise-level catch).
globalThis.document.addEventListener ||= () => {};
globalThis.document.removeEventListener ||= () => {};
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
import { makeMessage, resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import { generationCoordinator } from '../src/application/generation-coordinator.js';
import {
    PAYLOAD_KEY, stampPayload, writePayload,
} from '../src/domain/footnote-payload.js';
import { getVariantFootnotes } from '../src/cache.js';
import { bindEvents, unbindEvents } from '../src/events.js';
import {
    generateFootnotes, _testClearApiOverride, _testSetApiOverride,
} from '../src/generator.js';

const TEXT_A = 'Она вошла в серебряный лес, где свет луны ломался о ветви.';
const TEXT_B = 'Серебряный лес кончился; впереди лежала пустошь, поросшая вереском.';
const TEXT_C = 'Дорога вильнула к холмам; ветер нёс запах дождя и хвои.';
const FNS_A = [{ index: 1, anchor: 'серебряный лес', text: '¹ серебряный лес — note' }];

function settings(autoGenerate) {
    return {
        enabled: true,
        autoGenerate,
        soundEnabled: false,
        source: 'profile',
        selectedProfile: 'p1',
    };
}

const EVENT_TYPES = {
    APP_INITIALIZED: 'APP_INITIALIZED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED',
    MORE_MESSAGES_LOADED: 'MORE_MESSAGES_LOADED',
    WORLD_INFO_ACTIVATED: 'WORLD_INFO_ACTIVATED',
};

function bindAllEvents(chat, s) {
    const handlers = new Map();
    resetCtx({
        chat,
        chatId: 'surface-audit',
        chatMetadata: {},
        extensionSettings: { Glosses: s },
        event_types: EVENT_TYPES,
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

/** Fire every subscribed event for message 0, then settle the async chains. */
async function fireAllEvents(handlers) {
    for (const [ev, fns] of handlers) {
        const arg = ev === 'MESSAGE_SWIPE_DELETED' ? { messageId: 0 } : 0;
        await Promise.all(fns.map(fn => fn(arg))).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 200));
}

async function withApiCounter(fn) {
    let calls = 0;
    _testSetApiOverride(async () => {
        calls++;
        return JSON.stringify({ footnotes: [
            { anchor: 'серебряный лес', text: '¹ серебряный лес — gloss.' },
            { anchor: 'холмам', text: '² холмам — gloss.' },
        ] });
    });
    try {
        await fn();
        return calls;
    } finally {
        _testClearApiOverride();
    }
}

// ── message-state fixtures ──

/** Never glossed. */
const stateNoPayload = () => makeMessage({ mes: TEXT_A });

/** Verified payload on the current variant. */
function stateValidPayload() {
    const msg = makeMessage({ mes: TEXT_A });
    writePayload(msg, 0, stampPayload(msg, 0, FNS_A));
    return msg;
}

/** Stored payload whose text was edited in place (continue/edit). */
function stateStalePayload() {
    const msg = makeMessage({ swipes: [TEXT_A], swipe_id: 0 });
    writePayload(msg, 0, stampPayload(msg, 0, FNS_A));
    msg.swipes[0] = `${TEXT_A} Тропа вывела её к реке.`;
    msg.mes = msg.swipes[0];
    return msg;
}

/** Foreign clone: swipe 1 carries swipe 0's payload (ST's slot cloning). */
function stateForeignClone() {
    const msg = makeMessage({ swipes: [TEXT_A, TEXT_B], swipe_id: 1 });
    const payload = stampPayload(msg, 0, FNS_A);
    msg.swipe_info[0].extra[PAYLOAD_KEY] = payload;
    msg.swipe_info[1].extra[PAYLOAD_KEY] = structuredClone(payload);
    msg.extra = structuredClone(msg.swipe_info[1].extra);
    return msg;
}

/** Translated view: mes replaced by the translation, original kept aside. */
function stateTranslated() {
    const msg = makeMessage({ mes: 'She entered the silver forest, where moonlight broke on the branches.' });
    msg.extra.display_text = TEXT_A;
    return msg;
}

/** Streaming placeholder — the false-start guard territory. */
const statePlaceholder = () => makeMessage({ mes: '...' });

/** Hidden message (e.g. scenario message). */
const stateHidden = () => makeMessage({ mes: TEXT_A, is_hidden: true });

const STATES = {
    'no payload': stateNoPayload,
    'valid payload': stateValidPayload,
    'stale payload (edited text)': stateStalePayload,
    'foreign clone payload': stateForeignClone,
    'translated view': stateTranslated,
    'placeholder text': statePlaceholder,
    'hidden message': stateHidden,
};

// ── the matrix ──

for (const [label, make] of Object.entries(STATES)) {
    test(`autoGenerate off: full event storm on "${label}" never touches the API`, async () => {
        unbindEvents();
        state.configWarned = false;
        const handlers = bindAllEvents([make()], settings(false));
        try {
            const calls = await withApiCounter(() => fireAllEvents(handlers));
            assert.equal(calls, 0, `no API call may fire for state "${label}"`);
        } finally {
            unbindEvents();
        }
    });
}

test('autoGenerate off: a second consecutive event storm still stays quiet', async () => {
    unbindEvents();
    state.configWarned = false;
    const msg = stateNoPayload();
    const handlers = bindAllEvents([msg], settings(false));
    try {
        const calls = await withApiCounter(async () => {
            await fireAllEvents(handlers);
            // Render again after the storm — the message now has whatever the
            // storm left behind (expected: nothing).
            await Promise.all((handlers.get('CHARACTER_MESSAGE_RENDERED') || []).map(fn => fn('0')));
            await new Promise(r => setTimeout(r, 200));
        });
        assert.equal(calls, 0);
        assert.equal(getVariantFootnotes('0', 0), null);
    } finally {
        unbindEvents();
    }
});

// ── toggle-off mid-flight ──

test('toggle-off mid-flight aborts the in-flight auto run — nothing commits', async () => {
    unbindEvents();
    state.configWarned = false;
    const msg = stateNoPayload();
    const handlers = bindAllEvents([msg], settings(true));
    let resolveApi;
    try {
        _testSetApiOverride(() => new Promise(res => { resolveApi = res; }));
        await Promise.all((handlers.get('CHARACTER_MESSAGE_RENDERED') || []).map(fn => fn('0')));
        // Handlers are fire-and-forget (bg): wait until the run has actually
        // reached the API — past BOTH gate checks — so the flip below models
        // "toggle off while the LLM request is in flight".
        for (let i = 0; i < 100 && !resolveApi; i++) {
            await new Promise(r => setTimeout(r, 10));
        }
        assert.equal(typeof resolveApi, 'function', 'run must reach the API while the toggle is still on');
        // …the user flips the toggle off mid-flight. This is exactly what the
        // settings binding does (bindCb onChange): write the flag, then abort
        // the in-flight auto runs.
        state.settings.autoGenerate = false;
        generationCoordinator.abortAutoRuns();
        resolveApi(JSON.stringify({ footnotes: [
            { anchor: 'серебряный лес', text: '¹ серебряный лес — gloss.' },
        ] }));
        await new Promise(r => setTimeout(r, 300));
        assert.equal(getVariantFootnotes('0', 0), null,
            'an auto run aborted by toggle-off must not commit');
        assert.equal(state.isGenerating['0'], undefined, 'generation state released');
    } finally {
        _testClearApiOverride();
        unbindEvents();
    }
});

test('manual path stays ungated by design: generateFootnotes runs with autoGenerate off', async () => {
    unbindEvents();
    state.configWarned = false;
    bindAllEvents([stateNoPayload()], settings(false));
    try {
        const calls = await withApiCounter(async () => {
            // What the regen button / panel CTA / /glosses_regen invoke.
            await generateFootnotes('0', 0, null);
        });
        assert.equal(calls, 1, 'manual regeneration must work regardless of the toggle');
    } finally {
        unbindEvents();
    }
});
