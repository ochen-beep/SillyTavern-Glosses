// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Language mode extensions: custom target language, direction (forward/reverse),
// grammar notes and usage example toggles. The interpolation surface under test
// is bakeLensCopyText('language', ...) — the same path assembleStyle uses.
//
//   1. Custom language: name/label interpolate; label falls back to a derived tag.
//   2. Direction: reverse swaps the task/priorities wording; forward is default.
//   3. Grammar/usage toggles swap or drop their rules.
//   4. Generation refuses to start when custom is selected but unnamed.
//   5. Both language prompt files carry the new macro slots.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import { generateFootnotes, bakeLensCopyText, customLanguageIssue } from '../src/generator.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', 'prompts');

function setup(settings = {}) {
    resetCtx({
        chat: [
            { mes: 'Earlier reference to Aurelia.', is_user: false },
            { mes: 'Aurelia opened the astrolabe beside the old observatory.', is_user: false },
        ],
        chatId: 'language-mode',
        chatMetadata: {},
        extensionSettings: { Glosses: settings },
    });
    loadSettings();
    for (const k of Object.keys(state.promptCache)) delete state.promptCache[k];
}

test('custom language interpolates name and label from settings', () => {
    setup({ targetLanguage: 'custom', customTargetName: 'Ukrainian', customTargetLabel: 'укр.' });
    const baked = bakeLensCopyText('language', 'Study {{TARGET_LANG_NAME}} ({{TARGET_LANG_LABEL}})');
    assert.match(baked, /Study Ukrainian \(укр\.\)/);
});

test('custom language label falls back to a derived short tag', () => {
    setup({ targetLanguage: 'custom', customTargetName: 'Ukrainian', customTargetLabel: '' });
    const baked = bakeLensCopyText('language', '({{TARGET_LANG_LABEL}})');
    assert.match(baked, /\(Ukr\.\)/);
});

test('direction defaults to forward wording', () => {
    setup({ targetLanguage: 'en' });
    const baked = bakeLensCopyText('language', '{{DIRECTION_TASK}}');
    assert.match(baked, /teaches its English equivalent/);
    assert.doesNotMatch(baked, /learn by reading it/);
});

test('direction reverse swaps task and priorities wording', () => {
    setup({ targetLanguage: 'en', languageDirection: 'reverse' });
    const baked = bakeLensCopyText('language', '{{DIRECTION_TASK}} {{DIRECTION_PRIORITIES}}');
    assert.match(baked, /learn by reading it/);
    assert.doesNotMatch(baked, /teaches its English equivalent/);
    // Reverse anchors live in the study language; explanations go the other way.
    assert.match(baked, /a learner at the selected CEFR level/);
});

test('grammar rule swaps between ban and inclusion', () => {
    setup({ targetLanguage: 'en' });
    const off = bakeLensCopyText('language', '{{GRAMMAR_RULE}}');
    assert.match(off, /Do NOT include grammar gender/);
    setup({ targetLanguage: 'en', languageGrammarNotes: true });
    const on = bakeLensCopyText('language', '{{GRAMMAR_RULE}}');
    assert.match(on, /Include brief grammar notes/);
    assert.doesNotMatch(on, /Do NOT include grammar gender/);
});

test('usage rule appears only when enabled', () => {
    setup({ targetLanguage: 'en' });
    assert.doesNotMatch(bakeLensCopyText('language', '{{USAGE_RULE}}'), /usage example/);
    setup({ targetLanguage: 'en', languageUsageExample: true });
    assert.match(bakeLensCopyText('language', '{{USAGE_RULE}}'), /End the body with one short usage example/);
});

test('custom language without a name blocks generation', async () => {
    setup({ targetLanguage: 'custom', customTargetName: '' });
    assert.equal(customLanguageIssue(), 'Enter the custom language name in settings.');
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('should not fetch'); };
    try {
        await generateFootnotes(1, 0, null);
    } finally {
        globalThis.fetch = orig;
    }
    assert.equal(calls, 0, 'no API/fetch work happens for an unnamed custom language');
});

test('named custom language passes the gate', () => {
    setup({ targetLanguage: 'custom', customTargetName: 'Ukrainian' });
    assert.equal(customLanguageIssue(), null);
});

test('non-custom targets never trip the gate', () => {
    setup({ targetLanguage: 'en' });
    assert.equal(customLanguageIssue(), null);
});

test('language prompt files carry the new macro slots', () => {
    const styleSrc = readFileSync(join(promptsDir, 'language.md'), 'utf8');
    for (const macro of ['{{DIRECTION_TASK}}', '{{DIRECTION_PRIORITIES}}', '{{GRAMMAR_RULE}}', '{{USAGE_RULE}}']) {
        assert.ok(styleSrc.includes(macro), `language.md must carry ${macro}`);
    }
    const lensSrc = readFileSync(join(promptsDir, 'lenses', 'language.md'), 'utf8');
    for (const macro of ['{{DIRECTION_PRIORITIES}}', '{{GRAMMAR_RULE}}', '{{USAGE_RULE}}']) {
        assert.ok(lensSrc.includes(macro), `lenses/language.md must carry ${macro}`);
    }
    assert.ok(!lensSrc.includes('{{DIRECTION_TASK}}'),
        'the lens has a Voice line, not the task sentence — task lives in language.md');
});

test('language examples are direction-keyed for both locales', async () => {
    // Data-shape contract consumed by generator.js: [locale][direction].
    const { PROMPT_EXAMPLES } = await import('../src/prompt-examples.js');
    for (const locale of ['en', 'ru']) {
        const forLocale = PROMPT_EXAMPLES.language?.[locale];
        assert.ok(forLocale, `language examples exist for ${locale}`);
        assert.ok(forLocale.forward && forLocale.reverse, `both directions exist for ${locale}`);
        assert.notEqual(forLocale.forward, forLocale.reverse);
    }
});
