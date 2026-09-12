// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Popup custom CSS layer — pure helpers, settings coercion, publish path.
// DOM-dependent paths are exercised against tiny local document fakes; the
// stub runtime stays loaded FIRST so src modules evaluate.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S } from '../src/core.js';

test('defaults expose the custom CSS layer keys', () => {
    resetCtx({ extensionSettings: { Glosses: {} } });
    loadSettings();
    assert.equal(S().customCss, '');
    assert.equal(S().customCssEnabled, true);
});

test('loadSettings coerces junk customCss/customCssEnabled back to safe types', () => {
    let saved = 0;
    resetCtx({
        extensionSettings: { Glosses: { customCss: 42, customCssEnabled: 'yes' } },
        saveSettingsDebounced: () => { saved++; },
    });
    loadSettings();
    assert.equal(S().customCss, '', 'non-string customCss resets to empty string');
    assert.equal(S().customCssEnabled, true, 'non-boolean customCssEnabled resets to true');
    assert.equal(saved, 1, 'coercion marks settings changed and persists the repair');
});

test('loadSettings keeps valid custom CSS values untouched', () => {
    resetCtx({ extensionSettings: { Glosses: { customCss: '.gls-popup{color:red}', customCssEnabled: false } } });
    loadSettings();
    assert.equal(S().customCss, '.gls-popup{color:red}');
    assert.equal(S().customCssEnabled, false);
});
