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
    buildUserPrompt, generateFootnotes, _testSetApiOverride, _testClearApiOverride,
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
