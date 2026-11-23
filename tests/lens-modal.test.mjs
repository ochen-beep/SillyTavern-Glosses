// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Lens modal editor contracts (the ✎ editor moved into a native ST modal):
//   1. Macro hint list: OUTPUT_LANGUAGE first (universal), every language
//      token present and marked lens-only.
//   2. Base template skeleton carries the lens role sections.
//   3. applyLensOverride: non-empty body writes the override, whitespace body
//      deletes it (same path as the Reset button), unknown lens ids rejected.
//   4. settings.html carries no trace of the removed inline editor / dots.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S } from '../src/core.js';
import { LENS_MACRO_HINTS, BASE_LENS_TEMPLATE, applyLensOverride } from '../src/ui/lens-editor.js';

const here = dirname(fileURLToPath(import.meta.url));

function fresh() {
    resetCtx({
        chat: [],
        chatId: 'lens-modal',
        chatMetadata: {},
        extensionSettings: { Glosses: {} },
    });
    loadSettings();
}

test('macro hints: OUTPUT_LANGUAGE first and universal, language tokens flagged', () => {
    assert.equal(LENS_MACRO_HINTS[0].token, '{{OUTPUT_LANGUAGE}}');
    assert.equal(LENS_MACRO_HINTS[0].lensOnly, false);
    for (const m of LENS_MACRO_HINTS.slice(1)) {
        assert.equal(m.lensOnly, true, `${m.token} must be marked lens-only`);
    }
    const tokens = LENS_MACRO_HINTS.map(m => m.token);
    for (const expected of [
        '{{TARGET_LANG_NAME}}', '{{TARGET_LANG_CODE}}', '{{TARGET_LANG_LABEL}}',
        '{{CEFR_LEVEL}}', '{{CEFR_LEVEL_DESC}}', '{{CONLANG_NOTE}}',
        '{{DIRECTION_TASK}}', '{{DIRECTION_PRIORITIES}}',
        '{{GRAMMAR_RULE}}', '{{USAGE_RULE}}',
    ]) {
        assert.ok(tokens.includes(expected), `macro hint missing: ${expected}`);
    }
    assert.equal(tokens.length, 11, '11 macros documented');
    for (const m of LENS_MACRO_HINTS) {
        assert.ok(m.desc && m.desc.length > 4, `${m.token} needs a description`);
    }
});

test('base template skeleton carries the lens role sections', () => {
    assert.match(BASE_LENS_TEMPLATE, /### Lens:/);
    assert.match(BASE_LENS_TEMPLATE, /\*\*Voice:\*\*/);
    assert.match(BASE_LENS_TEMPLATE, /\*\*Footnote when:\*\*/);
    assert.match(BASE_LENS_TEMPLATE, /\*\*Do NOT footnote:\*\*/);
    assert.match(BASE_LENS_TEMPLATE, /\*\*Label:\*\*/);
    assert.match(BASE_LENS_TEMPLATE, /\*\*Format quirk:\*\*/);
});

test('applyLensOverride writes a non-empty body and invalidates the cache', () => {
    fresh();
    let invalidated = 0;
    const ok = applyLensOverride('pratchett', 'CUSTOM BODY', { invalidate: () => { invalidated++; } });
    assert.equal(ok, true);
    assert.equal(S().builtinLensOverrides.pratchett, 'CUSTOM BODY');
    assert.equal(invalidated, 1, 'cache invalidation hook runs once per write');
});

test('applyLensOverride deletes the override on a whitespace body', () => {
    fresh();
    applyLensOverride('pratchett', 'CUSTOM BODY');
    const ok = applyLensOverride('pratchett', '   \n ');
    assert.equal(ok, true);
    assert.ok(!('pratchett' in S().builtinLensOverrides), 'whitespace body means reset-to-bundled');
});

test('applyLensOverride rejects unknown lens ids', () => {
    fresh();
    assert.equal(applyLensOverride('bogus', 'x'), false);
    assert.deepEqual(S().builtinLensOverrides, {});
});

test('settings.html carries no trace of the removed inline editor / dots', () => {
    const src = readFileSync(join(here, '..', 'settings.html'), 'utf8');
    assert.ok(!src.includes('gls_builtin_lens_editor'), 'inline editor block must be gone');
    assert.ok(!src.includes('gls_builtin_lens_input'), 'inline editor textarea must be gone');
    assert.ok(!src.includes('data-gls-lens-dot'), 'override dots must be gone');
    assert.ok(!src.includes('gls-lens-override-dot'), 'dot css hook must be gone from markup');
    // The edit/copy buttons stay: they now drive the modal.
    const editCount = (src.match(/data-gls-lens-edit=/g) || []).length;
    assert.equal(editCount, 6, 'all six built-in lens rows keep their ✎ buttons');
    const copyCount = (src.match(/data-gls-lens-copy=/g) || []).length;
    assert.equal(copyCount, 6, 'all six built-in lens rows keep their ⧉ buttons');
});
