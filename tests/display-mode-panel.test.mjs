// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Q#3 — panel display mode force-enables the floating panel (it is the ONLY
// footnote surface there). That side effect must not outlive the mode:
// entering panel mode snapshots the pre-panel {enabled, hidden} pair and
// leaving panel mode restores it. Contracts pinned here:
//
//   1. both → panel: master flags forced on, checkbox synced.
//   2. panel → popup: the pre-panel pair is restored (a mode side effect does
//      not persist after the mode is gone).
//   3. Reload corner: a bind that STARTS in panel mode has no snapshot — the
//      documented degradation is that the panel stays enabled on exit.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S } from '../src/core.js';
import { bindSettingsUI, unbindSettingsUI } from '../src/ui/settings-sync.js';

// closePopup() tears down document/window listeners; the stub document in
// stub-runtime has neither — supply no-op signatures for this test only.
globalThis.document.addEventListener = globalThis.document.addEventListener || (() => {});
globalThis.document.removeEventListener = globalThis.document.removeEventListener || (() => {});
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});
if (typeof globalThis.document.body.appendChild !== 'function') {
    globalThis.document.body.appendChild = () => {};
}
if (typeof globalThis.document.body.classList !== 'object') {
    globalThis.document.body.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
}
// updatePanel() with the panel enabled runs buildPanel() → isMobileViewport
// (screen/navigator) and a real element tree — a small fake element covers it.
globalThis.screen = { width: 1440, height: 900 };
// Node 22 ships a getter-only `navigator`; maxTouchPoints is already undefined
// there, which is exactly the touch-free answer isMobileViewport expects.
function makeFakeEl() {
    return {
        style: {},
        dataset: {},
        hidden: false,
        innerHTML: '',
        textContent: '',
        className: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 }),
        ownerDocument: null,
    };
}

function makeSelect() {
    return {
        value: '',
        _handlers: {},
        addEventListener(ev, fn) { (this._handlers[ev] ||= []).push(fn); },
        fire(ev) { for (const fn of this._handlers[ev] || []) fn({ target: this }); },
    };
}

function setup({ saved = {} } = {}) {
    const dmEl = makeSelect();
    const fpCb = makeSelect();          // checkbox stub: .checked is a plain field
    fpCb.checked = false;
    resetCtx({
        chat: [],
        chatId: 'display-mode-panel',
        chatMetadata: {},
        extensionSettings: { Glosses: { enabled: true, ...saved } },
    });
    const origGet = globalThis.document.getElementById;
    const origCreate = globalThis.document.createElement;
    globalThis.document.getElementById = (id) => {
        if (id === 'gls_settings_container') return {};
        if (id === 'gls_display_mode') return dmEl;
        if (id === 'gls_floating_panel') return fpCb;
        return origGet(id);
    };
    globalThis.document.createElement = () => makeFakeEl();
    loadSettings();
    unbindSettingsUI();                  // clear the idempotence guard
    bindSettingsUI();
    return {
        dmEl, fpCb,
        restore: () => { globalThis.document.getElementById = origGet; globalThis.document.createElement = origCreate; unbindSettingsUI(); },
    };
}

test('entering panel mode forces the panel on and snapshots the pre-state', () => {
    const { dmEl, fpCb, restore } = setup({
        saved: { displayMode: 'both', floatingPanelEnabled: false, floatingPanelHidden: false },
    });
    try {
        dmEl.value = 'panel';
        dmEl.fire('change');
        assert.equal(S().displayMode, 'panel');
        assert.equal(S().floatingPanelEnabled, true, 'mode forces the panel on');
        assert.equal(S().floatingPanelHidden, false);
        assert.equal(fpCb.checked, true, 'checkbox mirrors the visible panel');
    } finally {
        restore();
    }
});

test('leaving panel mode restores the pre-panel state (no side-effect residue)', () => {
    const { dmEl, fpCb, restore } = setup({
        saved: { displayMode: 'both', floatingPanelEnabled: false, floatingPanelHidden: true },
    });
    try {
        dmEl.value = 'panel';
        dmEl.fire('change');
        dmEl.value = 'popup';
        dmEl.fire('change');
        assert.equal(S().floatingPanelEnabled, false, 'pre-panel enabled restored');
        assert.equal(S().floatingPanelHidden, true, 'pre-panel hidden restored');
        assert.equal(fpCb.checked, false, 'checkbox mirrors the restored state');
    } finally {
        restore();
    }
});

test('reload corner: a bind already in panel mode has no snapshot — exit keeps it on', () => {
    const { dmEl, fpCb, restore } = setup({
        saved: { displayMode: 'panel', floatingPanelEnabled: true, floatingPanelHidden: false },
    });
    try {
        dmEl.value = 'both';
        dmEl.fire('change');
        assert.equal(S().floatingPanelEnabled, true, 'documented degradation: stays enabled');
        assert.equal(fpCb.checked, true);
    } finally {
        restore();
    }
});
