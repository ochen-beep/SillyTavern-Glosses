// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Auto footnote count (model-decided) + built-in lens overrides contracts:
//   1. loadSettings coerces the new settings keys to their storage shapes.
//   2. Auto-count mode swaps the exact-N contract for model-decided wording
//      and keeps every validated footnote (no slice to N).
//   3. Lens overrides shadow the bundled prompts/lenses/<id>.md templates;
//      untouched lenses still load from disk; language tokens interpolate
//      identically for both surfaces.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import {
    buildUserPrompt, generateFootnotes, assembleStyle, bakeLensCopyText,
    _testSetApiOverride, _testClearApiOverride,
} from '../src/generator.js';
import { listFootnoteSets } from '../src/cache.js';

const POST = 'Aurelia opened the astrolabe beside the old observatory.';

function setup(settings = {}) {
    resetCtx({
        chat: [
            { mes: 'Earlier reference to Aurelia.', is_user: false },
            { mes: POST, is_user: false },
        ],
        chatId: 'lens-overrides',
        chatMetadata: {},
        extensionSettings: { Glosses: settings },
    });
    loadSettings();
    for (const k of Object.keys(state.promptCache)) delete state.promptCache[k];
}

test('loadSettings coerces autoFootnoteCount to boolean', () => {
    setup({ autoFootnoteCount: 'yes' });
    assert.equal(state.settings.autoFootnoteCount, false, 'non-boolean falls back to false');
    setup({ autoFootnoteCount: true });
    assert.equal(state.settings.autoFootnoteCount, true, 'explicit true is kept');
});

test('auto count mode swaps the exact-N contract for model-decided wording', async () => {
    setup({ autoFootnoteCount: true, maxFootnotes: 3 });
    const prompt = await buildUserPrompt(1, 0);
    assert.doesNotMatch(prompt, /exactly \d+ distinct footnotes/);
    assert.match(prompt, /Decide yourself how many footnotes/);
});

test('auto count mode keeps every footnote the model returns (no slice to N)', async () => {
    setup({ autoFootnoteCount: true, maxFootnotes: 3 });
    _testSetApiOverride(async () => JSON.stringify({ footnotes: [
        { anchor: 'Aurelia', text: '¹ Aurelia (name) — a proper name.' },
        { anchor: 'astrolabe', text: '² Astrolabe (instrument) — an astronomical device.' },
        { anchor: 'observatory', text: '³ Observatory (place) — a place for observing stars.' },
        { anchor: 'opened', text: '⁴ Opened (verb) — past tense of open.' },
        { anchor: 'old', text: '⁵ Old (adj.) — aged.' },
        { anchor: 'beside', text: '⁶ Beside (prep.) — next to.' },
        { anchor: 'the', text: '⁷ The (art.) — definite article.' },
    ] }));
    try {
        await generateFootnotes(1, 0, null);
    } finally {
        _testClearApiOverride();
    }
    const sets = listFootnoteSets();
    assert.equal(sets.length, 1);
    assert.equal(sets[0].footnotes.length, 7, 'all 7 model footnotes persist despite maxFootnotes=3');
});

// Fetch stub keyed by URL suffix (hybrid envelope + lens files).
function stubPromptFetch(routes) {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const path = String(url);
        for (const [suffix, body] of Object.entries(routes)) {
            if (path.endsWith(suffix)) return { ok: true, status: 200, text: async () => body };
        }
        return { ok: false, status: 404, text: async () => '' };
    };
    return () => { globalThis.fetch = orig; };
}

test('loadSettings coerces builtinLensOverrides (string values, known lens ids only)', () => {
    setup({ builtinLensOverrides: { language: 'Custom text', pratchett: 42, bogus: 'x' } });
    assert.deepEqual(state.settings.builtinLensOverrides, { language: 'Custom text' });
});

test('override replaces the bundled lens template; other lenses still load from disk', async () => {
    setup({
        promptStyle: 'hybrid',
        hybridLenses: { language: true, pratchett: true, canon: false, academic: false, meta: false, expansion: false },
        builtinLensOverrides: { language: 'OVERRIDE-BODY {{TARGET_LANG_NAME}}' },
    });
    const restore = stubPromptFetch({
        'prompts/hybrid.md': 'ENV{{LENSES}}ENV',
        'prompts/lenses/language.md': 'DISK-LANGUAGE-SHOULD-NOT-APPEAR',
        'prompts/lenses/pratchett.md': 'DISK-PRATCHETT',
    });
    try {
        const style = await assembleStyle();
        assert.match(style, /OVERRIDE-BODY English/, 'override wins and language tokens interpolate');
        assert.doesNotMatch(style, /DISK-LANGUAGE-SHOULD-NOT-APPEAR/);
        assert.match(style, /DISK-PRATCHETT/, 'untouched lens is still served from disk');
    } finally {
        restore();
    }
});

test('bakeLensCopyText bakes language tokens; other lenses keep {{OUTPUT_LANGUAGE}} raw', () => {
    setup({ targetLanguage: 'ja', cefrLevel: 'b1b2' });
    assert.match(bakeLensCopyText('language', 'Study {{TARGET_LANG_NAME}} at {{CEFR_LEVEL}}'), /Study Japanese at b1b2/);
    assert.equal(bakeLensCopyText('pratchett', 'Voice {{OUTPUT_LANGUAGE}}'), 'Voice {{OUTPUT_LANGUAGE}}',
        'custom-lens build path substitutes OUTPUT_LANGUAGE itself at generation time');
});
