// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// B#1 (QA 2026-11-03) — the restore race. restoreHighlightsAll runs on
// APP_INITIALIZED and CHAT_CHANGED(+0 ms); when the chat body renders LATER
// than both moments, the pass sees zero .mes nodes and nothing re-runs it —
// CHARACTER_MESSAGE_RENDERED does not fire when a saved chat is reopened
// (measured on the QA bench). The fix is a #chat childList observer routing
// every APPEARING .mes to restoreMessage. These tests pin the contract:
//
//   1. APP_INITIALIZED arms exactly one #chat observer (Node shim), even
//      across repeated CHAT_CHANGED re-arms.
//   2. A .mes node ADDED after the events (the race window) reaches
//      restoreMessage — proven via a getAttribute spy, the first call
//      restoreMessage makes.
//   3. unbindEvents disconnects the observer (no post-disable restores).

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { bindEvents, unbindEvents } from '../src/events.js';

// Minimal MutationObserver shim: records creations, lets the test emit
// synthetic mutation records. Node.ELEMENT_NODE is a browser global — the
// events module references it inside the observer callback, so the shim
// run needs it on globalThis too.
class MOShim {
    static created = [];
    constructor(cb) { this.cb = cb; MOShim.created.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    emit(addedNodes) { this.cb([{ addedNodes }], this); }
}
globalThis.MutationObserver = MOShim;
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
// restoreHighlightsAll's lazy injector arms an IntersectionObserver on boot.
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

/** A fake .mes element: records restoreMessage's first getAttribute probe. */
function makeMesEl(id) {
    return {
        probed: false,
        nodeType: 1,
        matches: () => true,
        querySelectorAll: () => [],
        querySelector: () => null,
        getAttribute(name) {
            if (name === 'mesid') { this.probed = true; }
            return id;
        },
    };
}

function setup({ chat = [] } = {}) {
    const handlers = new Map();
    const fakeChatEl = {
        nodeType: 1,
        addEventListener() {},
        removeEventListener() {},
    };
    MOShim.created = [];
    resetCtx({
        chat,
        chatId: 'restore-observer',
        chatMetadata: {},
        extensionSettings: { Glosses: { enabled: true } },
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
            on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); },
            removeListener: (ev, fn) => {
                const list = handlers.get(ev) || [];
                const i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            },
        },
    });
    // Route the events module's #chat lookups (observer mount) to the fake.
    const origGet = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => id === 'chat' ? fakeChatEl : origGet(id);
    loadSettings();
    bindEvents();
    return {
        fakeChatEl,
        fire: (ev, arg) => Promise.all((handlers.get(ev) || []).map(fn => fn(arg))),
        restoreDocumentGet: () => { globalThis.document.getElementById = origGet; },
    };
}

test('APP_INITIALIZED arms exactly one #chat observer across repeated chat changes', async () => {
    const { fire, restoreDocumentGet } = setup({ chat: [makeMessage({ mes: 'Post with cached footnotes.' })] });
    try {
        await fire('APP_INITIALIZED');
        assert.equal(MOShim.created.length, 1, 'one observer on app-ready');
        await fire('CHAT_CHANGED');
        await fire('CHAT_CHANGED');
        assert.equal(MOShim.created.length, 1, 'chat changes re-use the observer');
        assert.equal(MOShim.created[0].disconnected, undefined, 'still attached');
    } finally {
        unbindEvents();
        restoreDocumentGet();
    }
});

test('a .mes node added AFTER the boot events reaches restoreMessage (race window)', async () => {
    const { fire, restoreDocumentGet } = setup({ chat: [makeMessage({ mes: 'Post with cached footnotes.' })] });
    try {
        await fire('APP_INITIALIZED');
        await fire('CHAT_CHANGED');
        // The race: the pass above saw zero .mes nodes; the node appears now,
        // with no further ST events.
        const lateMes = makeMesEl('0');
        MOShim.created[0].emit([lateMes]);
        assert.equal(lateMes.probed, true, 'restoreMessage probed the late node (getAttribute mesid)');
    } finally {
        unbindEvents();
        restoreDocumentGet();
    }
});

test('unbindEvents disconnects the restore observer', async () => {
    const { fire, restoreDocumentGet } = setup({ chat: [] });
    try {
        await fire('APP_INITIALIZED');
        const mo = MOShim.created[0];
        unbindEvents();
        assert.equal(mo.disconnected, true, 'observer detached with the events');
    } finally {
        restoreDocumentGet();
    }
});
