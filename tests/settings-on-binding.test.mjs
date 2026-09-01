// @ts-check
// Regression test for the on() helper in settings-sync.js.
//
// The stub-runtime's document returns null for every getElementById and [] for
// every querySelectorAll, so bindSettingsUI's on() was never reached in the
// existing tests — which is exactly how the v3.1 recursion bug slipped through:
// both branches of on() recursed into itself instead of calling
// addEventListener, overflowing the stack (RangeError) on the first bind in a
// real browser and killing the rest of init().
//
// This file drives bindSettingsUI against a fake document whose elements DO
// have addEventListener, and asserts:
//   1. bindSettingsUI completes without throwing (the regression);
//   2. every listener is registered through real addEventListener with the
//      module AbortController's signal threaded into the options;
//   3. the bound handlers actually work (accordion toggle, preset merge,
//      bindNum input, master toggle);
//   4. unbindSettingsUI aborts the signal and the fake elements drop every
//      listener registered with it (mirroring the DOM AbortSignal contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { bindSettingsUI, unbindSettingsUI } from '../src/ui/settings-sync.js';
import { loadSettings, state, S } from '../src/core.js';

function freshSettingsContext(settings = {}) {
    resetCtx({ extensionSettings: { Glosses: settings } });
    loadSettings();
}

// ── Minimal fake DOM (only what bindSettingsUI touches) ──────────────────────

class FakeElement {
    constructor(id = null) {
        this.id = id;
        this.listeners = {};       // ev → [{fn, opts}]
        this.checked = false;
        this.value = '';
        this.hidden = false;
        this._html = '';
        this.attrs = {};
        this.dataset = {};
        this.style = { setProperty() {}, transform: '' };
        this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
        this.nextElementSibling = null;
        this.children = [];
    }
    set innerHTML(v) { this._html = String(v ?? ''); this.children = []; }
    get innerHTML() { return this._html; }
    appendChild(el) { this.children.push(el); return el; }
    /** Element.append (variadic) — used by the color-picker builder. */
    append(...els) { els.forEach(e => this.children.push(e)); return this; }
    // color-picker popover mount: settings-sync appends to hcBtn.parentElement.
    parentElement = null;
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() { this.focusCalled = true; }
    addEventListener(ev, fn, opts) {
        (this.listeners[ev] ||= []).push({ fn, opts: opts || {} });
    }
    /** Drop listeners registered with the given AbortSignal (DOM contract). */
    removeListenersFor(signal) {
        for (const ev of Object.keys(this.listeners)) {
            this.listeners[ev] = this.listeners[ev].filter(l => l.opts?.signal !== signal);
        }
    }
}

class FakeDocument {
    constructor() {
        this.elements = new Map();
        this.headers = [];
        this.body = { classList: { add() {}, remove() {} } };
        this.root = new FakeElement('root');
    }
    register(id) {
        const el = new FakeElement(id);
        this.elements.set(id, el);
        return el;
    }
    get(id) { return this.elements.get(id) ?? null; }
    getElementById(id) { return this.get(id); }
    querySelectorAll(sel) {
        if (sel === '#gls_settings .gls-s-section-header') return this.headers;
        return [];
    }
    querySelector() { return null; }
    get documentElement() { return this.root; }
    createElement() { return new FakeElement(null); }
    removeListeners(signal) {
        for (const el of this.elements.values()) el.removeListenersFor(signal);
        for (const el of this.headers) el.removeListenersFor(signal);
        this.root.removeListenersFor(signal);
    }
}

// ── Spy AbortController: honors abort() by dropping signal-scoped listeners ──

let fakeDoc = null;
const spyInstances = [];
class SpyAbortController {
    constructor() {
        this.signal = { __glsTestSignal: true };
        this.aborted = false;
        spyInstances.push(this);
    }
    abort() {
        this.aborted = true;
        fakeDoc?.removeListeners(this.signal);
    }
}

/** Install the fake document for the duration of fn (async-safe: the fake is
 *  torn down only after fn's promise settles, so awaits inside fn still see it). */
function withFakeDom(fn) {
    const origDoc = globalThis.document;
    const origCtor = globalThis.AbortController;
    fakeDoc = new FakeDocument();
    globalThis.document = fakeDoc;
    globalThis.AbortController = SpyAbortController;
    spyInstances.length = 0;
    const restore = () => {
        globalThis.document = origDoc;
        globalThis.AbortController = origCtor;
        fakeDoc = null;
    };
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(v => { restore(); return v; }, e => { restore(); throw e; });
        }
        restore();
        return result;
    } catch (e) {
        restore();
        throw e;
    }
}

/** Register the settings controls bindSettingsUI binds + one accordion header.
 *  The header's chevron is a STABLE instance so handler writes are observable. */
function seedControls() {
    for (const id of [
        'gls_enabled', 'gls_preset', 'gls_prompt_style', 'gls_output_language',
        'gls_floating_panel', 'gls_auto_generate', 'gls_gloss_user', 'gls_sound_enabled',
        'gls_context_depth', 'gls_highlight_color_btn', 'gls_highlight_opacity',
        'gls_stop_words', 'gls_sound_volume',
        'gls_font_family', 'gls_font_size', 'gls_font_size_val',
        'gls_panel_font_family', 'gls_panel_font_size', 'gls_panel_font_size_val',
        'gls_popup_theme', 'gls_popup_density', 'gls_popup_shadow',
        'gls_popup_corner', 'gls_popup_corner_val',
    ]) fakeDoc.register(id);
    // Picker trigger internals (swatch + hex readout read .style/.textContent).
    fakeDoc.register('gls_highlight_color_swatch');
    fakeDoc.register('gls_highlight_color_hex');
    // The picker trigger's row: settings-sync appends the popover to it.
    fakeDoc.get('gls_highlight_color_btn').parentElement = new FakeElement('gls_hl_row');

    const header = fakeDoc.register('gls_accordion_header');
    header.nextElementSibling = new FakeElement('gls_accordion_body');
    header.nextElementSibling.hidden = true;   // accordions start collapsed
    header.chevron = new FakeElement('gls_chevron');
    header.querySelector = () => header.chevron;
    fakeDoc.headers.push(header);
    return header;
}

test('loadSettings migrates removed Hybrid ALL and normalizes footnote language', () => {
    freshSettingsContext({
        selectedPreset: 'hybrid-all-ru',
        promptStyle: 'hybrid',
        outputLanguage: 'de',
        hybridLenses: {
            language: true, pratchett: true, canon: true, academic: true, meta: true,
        },
    });

    assert.equal(S().selectedPreset, '');
    assert.equal(S().promptStyle, 'hybrid');
    assert.equal(S().outputLanguage, 'ru');
    assert.deepEqual(S().hybridLenses, {
        language: true, pratchett: true, canon: true, academic: true, meta: true,
    });
    assert.equal(globalThis._stCtx.extensionSettings.Glosses.selectedPreset, '');
    assert.equal(globalThis._stCtx.extensionSettings.Glosses.outputLanguage, 'ru');
});

test('bindSettingsUI binds real listeners with the abort signal (regression: on() recursion)', () => {
    freshSettingsContext();
    withFakeDom(() => {
        const header = seedControls();

        // The regression: previously this threw RangeError (infinite recursion
        // inside on()), aborting init() right after the settings panel loaded.
        assert.doesNotThrow(() => bindSettingsUI());

        const signal = spyInstances[0].signal;
        assert.equal(spyInstances.length, 1, 'one controller created');

        // Every listener bound during bind must carry the module signal.
        for (const el of fakeDoc.elements.values()) {
            for (const ev of Object.keys(el.listeners)) {
                for (const l of el.listeners[ev]) {
                    assert.equal(l.opts.signal, signal, `${el.id} ${ev} carries the signal`);
                }
            }
        }

        // Spot-check counts on the binding patterns.
        assert.equal(header.listeners['click'].length, 1, 'accordion header bound once');
        assert.equal(fakeDoc.get('gls_preset').listeners['change'].length, 1, 'preset select bound');
        assert.equal(fakeDoc.get('gls_context_depth').listeners['input'].length, 1, 'bindNum input');
        assert.equal(fakeDoc.get('gls_context_depth').listeners['change'].length, 1, 'bindNum change');
        assert.equal(fakeDoc.get('gls_floating_panel').listeners['change'].length, 1, 'checkbox bound');

        // Leave the module unbound so the next test starts clean.
        unbindSettingsUI();
    });
});

test('bound handlers actually work through the fake DOM', async () => {
    freshSettingsContext();
    await withFakeDom(async () => {
        unbindSettingsUI();   // defensive: reset module state from a prior test
        const header = seedControls();
        bindSettingsUI();

        // Accordion toggle: hidden flips + aria-expanded + chevron rotation.
        // Note the handler's naming: `open` = the PRE-click state, so the
        // chevron ends up rotated while the section is expanded, '' when
        // collapsed (matches bindSettingsUI's wiring).
        const body = header.nextElementSibling;
        assert.equal(body.hidden, true);
        header.listeners['click'][0].fn();
        assert.equal(body.hidden, false);
        assert.equal(header.getAttribute('aria-expanded'), 'true');
        assert.equal(header.chevron.style.transform, 'rotate(-180deg)');
        header.listeners['click'][0].fn();
        assert.equal(body.hidden, true);
        assert.equal(header.getAttribute('aria-expanded'), 'false');
        assert.equal(header.chevron.style.transform, '');

        // Preset change merges the preset fields into S().
        const preset = fakeDoc.get('gls_preset');
        preset.value = 'pratchett50-ru';
        await preset.listeners['change'][0].fn();
        assert.equal(S().promptStyle, 'pratchett50');
        assert.equal(S().outputLanguage, 'ru');
        assert.equal(S().selectedPreset, 'pratchett50-ru');

        // Footnote language is a manual setting independent of prompt style.
        state.promptCache['pratchett50:Russian'] = 'stale';
        const outputLanguage = fakeDoc.get('gls_output_language');
        outputLanguage.value = 'en';
        outputLanguage.listeners['change'][0].fn();
        assert.equal(S().outputLanguage, 'en');
        assert.equal(S().selectedPreset, '', 'manual language edit enters manual mode');
        assert.deepEqual(state.promptCache, {}, 'language edit invalidates prompt cache');

        // bindNum input persists a numeric value.
        const depth = fakeDoc.get('gls_context_depth');
        depth.value = '7';
        depth.listeners['input'][0].fn();
        assert.equal(S().contextDepth, 7);

        // Master toggle off runs the removal path (applyHighlightStyles +
        // ensureLauncher against the fake document).
        const enabled = fakeDoc.get('gls_enabled');
        enabled.checked = false;
        enabled.listeners['change'][0].fn();
        assert.equal(S().enabled, false);

        unbindSettingsUI();
    });
});

test('unbind aborts the signal; signal-scoped listeners are removed and become no-ops', async () => {
    freshSettingsContext();
    await withFakeDom(async () => {
        unbindSettingsUI();   // defensive: reset module state from a prior test
        const header = seedControls();
        bindSettingsUI();
        const preset = fakeDoc.get('gls_preset');
        const depth = fakeDoc.get('gls_context_depth');
        assert.equal(header.listeners['click'].length, 1);

        unbindSettingsUI();
        assert.equal(spyInstances[0].aborted, true, 'unbind aborts the controller');

        // The fake honors the AbortSignal contract: listeners die with the signal.
        assert.equal(header.listeners['click'].length, 0, 'header listener removed');
        assert.equal(preset.listeners['change'].length, 0, 'preset listener removed');
        assert.equal(depth.listeners['input'].length, 0, 'bindNum listener removed');

        // Firing a removed listener is a no-op — state stays untouched.
        preset.value = 'lang-en-ru-a2';
        await preset.listeners['change'][0]?.fn();
        assert.equal(S().selectedPreset, '', 'unbound preset change does not persist');
    });
});

test('disable/enable cycle binds to a fresh signal, old listeners do not linger', () => {
    freshSettingsContext();
    withFakeDom(() => {
        unbindSettingsUI();   // defensive: reset module state from a prior test
        const header = seedControls();
        bindSettingsUI();
        unbindSettingsUI();
        bindSettingsUI();

        assert.equal(spyInstances.length, 2, 'fresh controller per bind');
        assert.equal(spyInstances[0].aborted, true, 'first cycle aborted');
        assert.equal(spyInstances[1].aborted, false, 'second cycle active');
        assert.equal(header.listeners['click'].length, 1, 'one live listener, no duplicates');
        assert.equal(header.listeners['click'][0].opts.signal, spyInstances[1].signal,
            'live listener carries the fresh signal');
        unbindSettingsUI();
        assert.equal(spyInstances[1].aborted, true);
    });
});
