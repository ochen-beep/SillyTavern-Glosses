// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stage 3 (DS Comments port) — whenSendFormReady + teardown disposal.
//
// The launcher/viewport attach previously probed #send_form with a
// 500 ms setInterval (8 s deadline). Attachment is event-driven now:
//   - #send_form present → synchronous attach, no subscription;
//   - absent → APP_READY subscription with a disposer; a disable before the
//     event must unsubscribe, or the late event attaches orphans after
//     teardown.
// These tests pin that contract at the whenSendFormReady level and through
// observeQrBar/removeLauncher.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { whenSendFormReady } from '../src/ui/dom-ready.js';
import { observeQrBar, removeLauncher } from '../src/ui/launcher.js';

// Node has no MutationObserver; launcher's sync attach path news one.
class FakeMO {
    constructor(fn) { this.fn = fn; this.observed = null; }
    observe(target) { this.observed = target; }
    disconnect() { this.disconnected = true; }
}
globalThis.MutationObserver = FakeMO;

function makeCtx() {
    const bag = new Map(); // event -> [fn]
    const ctx = {
        event_types: { APP_READY: 'APP_READY' },
        eventSource: {
            on: (ev, fn) => {
                if (!bag.has(ev)) bag.set(ev, []);
                bag.get(ev).push(fn);
            },
            removeListener: (ev, fn) => {
                const list = bag.get(ev) || [];
                const i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            },
        },
    };
    resetCtx(ctx);
    return {
        bag,
        fire: (ev) => [...(bag.get(ev) || [])].map(fn => fn()),
        count: (ev) => (bag.get(ev) || []).length,
    };
}

/** Temporarily control document.getElementById('send_form') in the stub. */
function withSendForm(present, fn) {
    const doc = globalThis.document;
    const orig = doc.getElementById;
    doc.getElementById = (id) => (id === 'send_form' && present ? { id: 'send_form' } : null);
    try {
        return fn();
    } finally {
        doc.getElementById = orig;
    }
}

// ── whenSendFormReady ──

test('whenSendFormReady: #send_form present → synchronous attach, no subscription', () => {
    const { count } = makeCtx();
    let attached = null;
    const dispose = withSendForm(true, () => whenSendFormReady((sf) => { attached = sf; }));
    assert.ok(attached, 'attached synchronously');
    assert.equal(count('APP_READY'), 0, 'no APP_READY subscription');
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose()); // disposer safe after attach
});

test('whenSendFormReady: #send_form absent → APP_READY attach; handler removes itself', () => {
    const { fire, count } = makeCtx();
    let attached = null;
    const dispose = withSendForm(false, () => whenSendFormReady((sf) => { attached = sf; }));
    assert.equal(attached, null);
    assert.equal(count('APP_READY'), 1);

    withSendForm(false, () => fire('APP_READY')); // still absent → onGiveUp path
    assert.equal(attached, null);
    assert.equal(count('APP_READY'), 0, 'handler removed itself after firing');

    withSendForm(true, () => { /* make it present, re-arm */ });
    dispose(); // no-op on empty bag
});

test('whenSendFormReady: #send_form absent, arrives on APP_READY → attached', () => {
    const { fire } = makeCtx();
    let attached = null;
    withSendForm(false, () => whenSendFormReady((sf) => { attached = sf; }));
    withSendForm(true, () => fire('APP_READY'));
    assert.ok(attached, 'attached on APP_READY');
});

test('whenSendFormReady: disposer unsubscribes before APP_READY fires', () => {
    const { fire, count } = makeCtx();
    let attached = null;
    const dispose = withSendForm(false, () => whenSendFormReady((sf) => { attached = sf; }));
    assert.equal(count('APP_READY'), 1);
    dispose();
    assert.equal(count('APP_READY'), 0, 'disposer removed the subscription');
    withSendForm(true, () => fire('APP_READY'));
    assert.equal(attached, null, 'late APP_READY does not attach after dispose');
});

test('whenSendFormReady: no APP_READY surface and absent #send_form → onGiveUp, safe disposer', () => {
    resetCtx({}); // no eventSource / event_types
    let gaveUp = false;
    let attached = null;
    const dispose = whenSendFormReady((sf) => { attached = sf; }, { onGiveUp: () => { gaveUp = true; } });
    assert.equal(gaveUp, true);
    assert.equal(attached, null);
    assert.doesNotThrow(() => dispose());
});

// ── observeQrBar / removeLauncher wiring ──

test('observeQrBar subscribes when #send_form is absent; removeLauncher disposes', () => {
    const { fire, count } = makeCtx();
    withSendForm(false, () => observeQrBar());
    assert.equal(count('APP_READY'), 1, 'waiting on APP_READY (no polling)');

    removeLauncher();
    assert.equal(count('APP_READY'), 0, 'teardown disposed the subscription');

    withSendForm(true, () => fire('APP_READY')); // would attach orphans pre-fix
    removeLauncher(); // idempotent
});

test('observeQrBar attaches immediately when #send_form is present', () => {
    const { count } = makeCtx();
    withSendForm(true, () => observeQrBar());
    assert.equal(count('APP_READY'), 0, 'sync attach, no subscription');
    removeLauncher();
});

test('observeQrBar is idempotent while a subscription is pending', () => {
    const { count } = makeCtx();
    withSendForm(false, () => { observeQrBar(); observeQrBar(); observeQrBar(); });
    assert.equal(count('APP_READY'), 1, 'no duplicate subscriptions');
    removeLauncher();
});
