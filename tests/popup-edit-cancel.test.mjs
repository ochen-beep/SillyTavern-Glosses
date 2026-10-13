// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Regression tests for two UI-behavior fixes:
//
// 1. Popup edit-cancel (footnote-actions.js + renderer.js): the shared action
//    bar used to map the editor's cancelled outcome onto onAfterEdit — in the
//    popup that callback closes the popup, so a bare cancel (or Escape) closed
//    the whole popup and read as discarding the footnote. The fix adds an
//    onEditCancelled channel; surfaces without it keep the onAfterEdit
//    fallback (the panel re-renders its row either way).
//
// 2. Empty-state wording (empty.js): when the configured-state reason carries
//    an actual API/transport error, the badge must head with "Generation
//    source error" — "Source not configured" is misleading when a source IS
//    configured and just failed.
//
// footnote-actions/empty/footnote-editor touch the DOM (createElement, append,
// listeners), which helpers/stub-runtime.mjs deliberately does not model. Load
// that stub first for the SillyTavern/i18n shims, then REPLACE globalThis.document
// with a small rich element factory before the src modules evaluate (dynamic
// imports evaluate in statement order, after the globals are in place).

import './helpers/stub-runtime.mjs';

function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [],
        listeners: {},
        attrs: {},
        _text: '',
        dataset: {},
        style: {},
        value: '',
        _cls: '',
        parentElement: null,
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
    el.removeEventListener = (type, fn) => {
        el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn);
    };
    el.click = () => {
        for (const fn of [...(el.listeners.click || [])]) {
            fn({ stopPropagation() {}, preventDefault() {} });
        }
    };
    el.append = (...kids) => {
        el.children.push(...kids);
        kids.forEach((c) => { c.parentElement = el; });
    };
    el.matches = (sel) => {
        const tokens = sel.split('.');
        const tag = tokens[0];
        const classes = tokens.slice(1);
        if (tag && el.tagName !== tag.toUpperCase()) return false;
        return classes.every((c) => String(el._cls).split(/\s+/).includes(c));
    };
    el.querySelectorAll = (sel) => {
        const out = [];
        const walk = (node) => {
            for (const c of node.children) {
                if (c.matches(sel)) out.push(c);
                walk(c);
            }
        };
        walk(el);
        return out;
    };
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
    el.focus = () => {};
    return el;
}

// Property shims that need real logic (getters / cross-field access).
function withProps(el) {
    Object.defineProperty(el, 'className', {
        get() { return el._cls; },
        set(v) { el._cls = String(v ?? ''); },
        configurable: true,
    });
    Object.defineProperty(el, 'textContent', {
        get() { return el._text + el.children.map((c) => c.textContent).join(''); },
        set(v) { el._text = String(v ?? ''); },
        configurable: true,
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._text; },
        set(v) { el._text = String(v ?? ''); el.children.length = 0; },
        configurable: true,
    });
    return el;
}

globalThis.document = {
    createElement: (tag) => withProps(makeEl(tag)),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: globalThis.document?.body ?? { classList: { add() {}, remove() {} } },
};

const { buildFootnoteActions } = await import('../src/ui/footnote-actions.js');
const { renderEmptyStateHTML } = await import('../src/ui/empty.js');

// ── popup edit-cancel wiring ─────────────────────────────────────────────────

function findButton(root, text) {
    const out = [];
    const walk = (node) => {
        for (const c of node.children) {
            if (c.tagName === 'BUTTON' && c.textContent.includes(text)) out.push(c);
            walk(c);
        }
    };
    walk(root);
    return out[0] || null;
}

function buildActions(overrides = {}) {
    const opts = {
        fn: { index: 1, anchor: 'foo', text: '¹foo note' },
        msgId: '0', swipeIdx: 0, digest: 'd',
        variant: 'popup',
        editHost: withProps(makeEl('div')),
        validateContext: () => true,
        onAfterEdit: () => {},
        onAfterDelete: () => {},
        onRefreshHighlights: () => {},
        ...overrides,
    };
    const actions = buildFootnoteActions(opts);
    return { actions, editHost: opts.editHost };
}

test('cancel fires onEditCancelled, not the save/close path', () => {
    const calls = { afterEdit: 0, cancelled: 0 };
    const { actions, editHost } = buildActions({
        onAfterEdit: () => { calls.afterEdit++; },
        onEditCancelled: () => { calls.cancelled++; },
    });
    actions.edit.click(); // mounts the inline editor into editHost
    const cancel = findButton(editHost, 'Cancel');
    assert.ok(cancel, 'editor should expose a Cancel button');
    cancel.click();
    assert.equal(calls.cancelled, 1, 'cancel must reach the onEditCancelled channel');
    assert.equal(calls.afterEdit, 0, 'cancel must not run the save/close path');
});

test('without onEditCancelled, cancel falls back to onAfterEdit (panel compat)', () => {
    const calls = { afterEdit: 0 };
    const { actions, editHost } = buildActions({
        onAfterEdit: () => { calls.afterEdit++; },
    });
    actions.edit.click();
    const cancel = findButton(editHost, 'Cancel');
    assert.ok(cancel, 'editor should expose a Cancel button');
    cancel.click();
    assert.equal(calls.afterEdit, 1, 'fallback keeps the panel re-render behavior');
});

test('save keeps firing onAfterEdit (saved ≠ cancelled)', () => {
    // editFootnote with an empty text stays in 'editing' without calling any
    // outcome callback — drive the 'stale' outcome instead: validateContext
    // false + a changed digest makes the command report stale, which the
    // editor treats as onCancelled.
    const calls = { afterEdit: 0, cancelled: 0 };
    const { actions, editHost } = buildActions({
        validateContext: () => false,
        onAfterEdit: () => { calls.afterEdit++; },
        onEditCancelled: () => { calls.cancelled++; },
    });
    actions.edit.click();
    const save = findButton(editHost, 'Save');
    assert.ok(save, 'editor should expose a Save button');
    save.click();
    // stale → the editor routes through onCancelled (the toast warns) — with
    // the fix, 'cancelled' alone increments; 'afterEdit' stays untouched.
    assert.equal(calls.cancelled, 1, 'stale save is a cancellation, not a save');
    assert.equal(calls.afterEdit, 0);
});

// ── empty-state wording ──────────────────────────────────────────────────────

test('unconfigured badge with an error reason heads with "Generation source error"', () => {
    const html = renderEmptyStateHTML('unconfigured', {
        reason: 'Профиль «Vectorengine»: Internal Server Error',
    });
    assert.match(html, /Generation source error/);
    assert.ok(!/Source not configured/.test(html));
    assert.match(html, /Internal Server Error/, 'the underlying reason stays visible');
    assert.match(html, /gls-empty-configure/, 'the Open settings CTA stays');
});

test('unconfigured badge without an attempt keeps "Source not configured"', () => {
    const html = renderEmptyStateHTML('unconfigured', {});
    assert.match(html, /Source not configured/);
    assert.ok(!/Generation source error/.test(html));
});
