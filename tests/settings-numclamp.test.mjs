// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Numeric-contract tests for the settings surface + core:
//   1. bindNum clamps typed values to the min/max the input declares in
//      settings.html (max footnotes 1–20, context depth 0–50) and normalizes
//      the visible field on commit (change), not mid-typing (input).
//   2. loadSettings repairs out-of-range persisted values on load.
//   3. core t() falls back to the ST CONTEXT translate (SillyTavern.getContext()
//      .translate — there is no SillyTavern.translate global) while the ESM
//      import of scripts/i18n.js has not settled. Under Node that import can
//      never settle (the relative host path does not exist), which is exactly
//      the degraded-surface window this fallback covers.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S, t } from '../src/core.js';
import { bindSettingsUI, unbindSettingsUI } from '../src/ui/settings-sync.js';

function makeNumInput(min, max) {
    return {
        value: '',
        _attrs: { min: String(min), max: String(max) },
        _handlers: {},
        getAttribute(k) { return this._attrs[k] ?? null; },
        addEventListener(ev, fn) { (this._handlers[ev] ||= []).push(fn); },
        fire(ev) { for (const fn of this._handlers[ev] || []) fn({ target: this }); },
    };
}

test('bindNum clamps typed values to the input min/max contract', () => {
    resetCtx({ extensionSettings: { Glosses: {} } });
    loadSettings();
    unbindSettingsUI(); // clear the idempotence guard if a prior test bound

    const footnotesEl = makeNumInput(1, 20);
    const depthEl = makeNumInput(0, 50);
    const origGet = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => {
        if (id === 'gls_max_footnotes') return footnotesEl;
        if (id === 'gls_context_depth') return depthEl;
        return origGet(id);
    };
    try {
        bindSettingsUI();
        assert.equal(String(footnotesEl.value), '5', 'field initialized from settings default');

        // Typed 25 → setting clamps to 20 on input, field normalizes on change.
        footnotesEl.value = '25';
        footnotesEl.fire('input');
        assert.equal(S().maxFootnotes, 20, 'above max clamps on input');
        footnotesEl.fire('change');
        assert.equal(String(footnotesEl.value), '20', 'field shows the clamped value on commit');

        // Typed 0 → clamps to 1.
        footnotesEl.value = '0';
        footnotesEl.fire('input');
        assert.equal(S().maxFootnotes, 1, 'below min clamps on input');
        footnotesEl.fire('change');
        assert.equal(String(footnotesEl.value), '1');

        // In-range values pass through untouched.
        footnotesEl.value = '7';
        footnotesEl.fire('change');
        assert.equal(S().maxFootnotes, 7);
        assert.equal(String(footnotesEl.value), '7');

        // Empty field on change → restore last good value, never wipe setting.
        footnotesEl.value = '';
        footnotesEl.fire('input');
        assert.equal(S().maxFootnotes, 7, 'empty input does not clobber the setting');
        footnotesEl.fire('change');
        assert.equal(String(footnotesEl.value), '7', 'empty field restores the setting on commit');

        // Context depth: negative → 0, above max → 50.
        depthEl.value = '-3';
        depthEl.fire('change');
        assert.equal(S().contextDepth, 0);
        assert.equal(String(depthEl.value), '0');
        depthEl.value = '99';
        depthEl.fire('change');
        assert.equal(S().contextDepth, 50);
        assert.equal(String(depthEl.value), '50');
    } finally {
        globalThis.document.getElementById = origGet;
        unbindSettingsUI();
    }
});

test('loadSettings repairs out-of-range persisted numerics', () => {
    resetCtx({ extensionSettings: { Glosses: { maxFootnotes: 25, contextDepth: 999 } } });
    loadSettings();
    assert.equal(S().maxFootnotes, 20);
    assert.equal(S().contextDepth, 50);

    resetCtx({ extensionSettings: { Glosses: { maxFootnotes: 0, contextDepth: -4 } } });
    loadSettings();
    assert.equal(S().maxFootnotes, 1);
    assert.equal(S().contextDepth, 0);

    resetCtx({ extensionSettings: { Glosses: { maxFootnotes: 'junk', contextDepth: null } } });
    loadSettings();
    assert.equal(S().maxFootnotes, 5, 'junk falls back to the default');
    assert.equal(S().contextDepth, 0, 'null falls back to the default');

    resetCtx({ extensionSettings: { Glosses: { maxFootnotes: 12, contextDepth: 3 } } });
    loadSettings();
    assert.equal(S().maxFootnotes, 12, 'in-range values are kept as-is');
    assert.equal(S().contextDepth, 3);
});

test('t() falls back to the context translate when the ESM import has not settled', () => {
    resetCtx({});
    globalThis._stCtx.translate = (text, key) => ((key ?? text) === 'Footnotes' ? 'Сноски' : text);
    assert.equal(t('Footnotes'), 'Сноски', 'context translate is used via the global fallback');
    assert.equal(t('Unknown key'), 'Unknown key', 'unknown keys fall back to the key itself');
    assert.equal(t('Auto-generation paused: {0}', 'reason'), 'Auto-generation paused: reason',
        'positional placeholders still substitute through the fallback');
});
