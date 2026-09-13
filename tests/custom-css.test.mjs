// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Popup custom CSS layer — pure helpers, settings coercion, publish path.
// DOM-dependent paths are exercised against tiny local document fakes; the
// stub runtime stays loaded FIRST so src modules evaluate.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S, t } from '../src/core.js';

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

import {
    mirrorPopupSelectors, STYLE_ID, MIRROR_ID,
} from '../src/ui/custom-css.js';

test('mirrorPopupSelectors rewrites only the exact .gls-popup token', () => {
    assert.equal(
        mirrorPopupSelectors('.gls-popup { color: red; }'),
        '.gls-popup-preview { color: red; }',
        'exact class token is mirrored',
    );
    assert.equal(
        mirrorPopupSelectors('.gls-popup-title { color: red; }'),
        '.gls-popup-title { color: red; }',
        'compound class .gls-popup-title is shared, not mirrored',
    );
    assert.equal(
        mirrorPopupSelectors('.gls-popup-preview { color: red; }'),
        '.gls-popup-preview { color: red; }',
        '.gls-popup-preview is never double-suffixed',
    );
    assert.equal(
        mirrorPopupSelectors('.gls-popup, .gls-popup-text { color: red; }'),
        '.gls-popup-preview, .gls-popup-text { color: red; }',
        'mixed selector list: only the bare token flips',
    );
    assert.equal(
        mirrorPopupSelectors('div.gls-popup{--x:1}'),
        'div.gls-popup-preview{--x:1}',
        'no-space brace and tag-qualified selector still mirror',
    );
    assert.equal(mirrorPopupSelectors(''), '');
    assert.equal(mirrorPopupSelectors(null), '', 'null-safe');
    assert.equal(mirrorPopupSelectors('.gls-popup'), '.gls-popup-preview', 'bare token at end of input still mirrors');
    assert.equal(
        mirrorPopupSelectors(':root.gls-popup-skin-paper .gls-popup{}'),
        ':root.gls-popup-skin-paper .gls-popup-preview{}',
        'skin class on :root stays, inner token flips',
    );
});

import { CUSTOM_CSS_BASELINE, countCssRules, insertTemplate } from '../src/ui/custom-css.js';

test('CUSTOM_CSS_BASELINE documents targets and contains a live example', () => {
    assert.ok(CUSTOM_CSS_BASELINE.includes('.gls-popup'), 'mentions the popup card');
    assert.ok(CUSTOM_CSS_BASELINE.includes('.gls-popup-text'), 'mentions the body class');
    assert.ok(CUSTOM_CSS_BASELINE.includes('--gls-popup-radius'), 'mentions a knob token');
    assert.ok(CUSTOM_CSS_BASELINE.includes('--gls-text-2'), 'close button token re-derived for dark themes');
    assert.notEqual(
        mirrorPopupSelectors(CUSTOM_CSS_BASELINE), CUSTOM_CSS_BASELINE,
        'template holds a bare .gls-popup token, so the mirror actually engages',
    );
});

test('countCssRules returns null when the CSS engine is unavailable (Node)', () => {
    // Node has no CSSStyleSheet — the guard must report null, not throw.
    assert.equal(countCssRules('.a{color:red}'), null);
});

test('countCssRules maps an engine rejection (e.g. @import) to 0', () => {
    const orig = globalThis.CSSStyleSheet;
    globalThis.CSSStyleSheet = class {
        replaceSync() { throw new DOMException('not allowed', 'NotAllowedError'); }
        get cssRules() { return { length: 0 }; }
    };
    try {
        assert.equal(countCssRules('@import url("x");'), 0);
    } finally {
        if (orig === undefined) delete globalThis.CSSStyleSheet;
        else globalThis.CSSStyleSheet = orig;
    }
});

test('countCssRules returns null when the engine is present but not constructable', () => {
    const orig = globalThis.CSSStyleSheet;
    globalThis.CSSStyleSheet = class {
        constructor() { throw new TypeError('Illegal constructor'); }
    };
    try {
        assert.equal(countCssRules('.a{color:red}'), null);
    } finally {
        if (orig === undefined) delete globalThis.CSSStyleSheet;
        else globalThis.CSSStyleSheet = orig;
    }
});

test('insertTemplate appends to non-empty text, replaces empty text', () => {
    assert.equal(insertTemplate('', 'TPL'), 'TPL');
    assert.equal(insertTemplate('   \n ', 'TPL'), 'TPL');
    assert.equal(insertTemplate('.a{}', 'TPL'), '.a{}\n\nTPL');
    assert.equal(insertTemplate('.a{}\n', 'TPL'), '.a{}\n\nTPL');
});

import { applyCustomCss, customCssStatusText } from '../src/ui/custom-css.js';

/** Local document fake with a real head/createElement/getElementById cycle. */
function fakeDocument() {
    const tags = new Map();
    const created = [];
    return {
        created,
        doc: {
            created,
            head: { appendChild(el) { created.push(el); if (el.id) tags.set(el.id, el); } },
            getElementById: (id) => tags.get(id) ?? null,
            createElement: () => {
                const el = {
                    id: '',
                    _text: '',
                    set textContent(v) { this._text = String(v ?? ''); },
                    get textContent() { return this._text; },
                };
                return el;
            },
            __register: (id, el) => tags.set(id, el),
        },
    };
}

test('applyCustomCss creates one style tag per id and reuses it (idempotent)', () => {
    const { doc } = fakeDocument();
    const realDoc = globalThis.document;
    globalThis.document = doc;
    try {
        resetCtx({ extensionSettings: { Glosses: {} } });
        loadSettings();
        S().customCss = '.gls-popup { color: red; }';
        S().customCssEnabled = true;

        applyCustomCss();
        applyCustomCss();
        assert.equal(doc.created.length, 2, 'exactly one tag per id across repeated applies');

        const raw = doc.created.find(el => !el.textContent.includes('gls-popup-preview'));
        const mirror = doc.created.find(el => el.textContent.includes('gls-popup-preview'));
        assert.ok(raw && mirror, 'both raw and mirror tags created');
        assert.ok(raw.textContent.includes('.gls-popup { color: red; }'));
        assert.ok(mirror.textContent.includes('.gls-popup-preview { color: red; }'));

        S().customCssEnabled = false;
        applyCustomCss();
        assert.deepEqual(
            doc.created.map(el => el.textContent),
            ['', ''],
            'disabled layer empties both tags in place (no re-creation)',
        );
    } finally {
        globalThis.document = realDoc;
    }
});

test('applyCustomCss is a safe no-op under the bare stub runtime (no head)', () => {
    const realDoc = globalThis.document;
    globalThis.document = { getElementById: () => null, createElement: () => ({}) };
    try {
        resetCtx({ extensionSettings: { Glosses: {} } });
        loadSettings();
        assert.doesNotThrow(() => applyCustomCss());
    } finally {
        globalThis.document = realDoc;
    }
});

test('customCssStatusText: empty → hidden, engine-less → Applied, engine → rule count', () => {
    resetCtx({ extensionSettings: { Glosses: {} } });
    loadSettings();
    assert.equal(customCssStatusText('   '), '', 'whitespace-only hides the status');
    // Node has no CSSStyleSheet → countCssRules is null → generic "Applied".
    assert.equal(customCssStatusText('.a{color:red}'), t('Applied'));
});
