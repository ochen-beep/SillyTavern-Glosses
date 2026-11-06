import { test } from 'node:test';
import assert from 'node:assert/strict';

// Load the ST/DOM stub FIRST so core.js (imported transitively by parser.js)
// can be evaluated under Node — it reads document.createElement and lodash at
// module-eval time. Replaces the old hack of rewriting parser.js's import line.
import './helpers/stub-runtime.mjs';
import {
    superscriptToIndex, indexToSuperscript, extractPostTextFromPrompt,
    validateFootnotes, validateFootnotesAgainstText,
} from '../src/parser.js';
import { findFuzzySpan } from '../src/text-index.js';

test('harness loads parser.js under Node', () => {
    assert.equal(superscriptToIndex('¹²'), 12);
    assert.equal(indexToSuperscript(12), '¹²');
});

test('extractPostTextFromPrompt reads a plain post block', () => {
    const prompt = '[Annotate this post:\nhello world\n]\n\n[Earlier in the scene:\n…]';
    // Old regex captured up to the first `]`, leaving a trailing newline in
    // the slice. After §4.3 hardening the trailing `\n` is consumed by the
    // `\n\]` terminator, so the asserted value tightens to 'hello world'.
    assert.equal(extractPostTextFromPrompt(prompt).trim(), 'hello world');
});

test('extractPostTextFromPrompt keeps text past a mid-string ]', () => {
    const post = '[somus] continues then ends.';
    const prompt = `[Annotate this post:\n${post}\n]\n\n[Earlier in the scene:\n…]`;
    assert.equal(extractPostTextFromPrompt(prompt), post);
});

test('extractPostTextFromPrompt handles EOF terminator (no following block)', () => {
    const post = 'just a sentence';
    const prompt = `[Annotate this post:\n${post}\n]`;
    assert.equal(extractPostTextFromPrompt(prompt), post);
});

// Regression: the REAL emitter (buildContextBlocks in generator.js) writes the
// block as `[Annotate this post:\n${cleanText}]` — cleanText comes from
// extractPlainText which `.trim()`s, so there is NO trailing `\n` before `]`.
// The previous regex required `\n\]` and returned '' here, which made
// validateFootnotes drop EVERY footnote as "not found" (the "Leaked
// candidates" + "Dropped invalid footnotes" storm in the console). These two
// cases pin the emitter's actual format.
test('extractPostTextFromPrompt reads the real emitter format (no \\n before ])', () => {
    const post = 'Ярослав подошёл к окну. На улице шёл дождь.';
    const contract = '[ANNOTATOR CONTRACT — direct footnotes, one response]';
    const prompt = `[Annotate this post:\n${post}]\n\n${contract}`;
    assert.equal(extractPostTextFromPrompt(prompt), post);
});

test('direct validation is exact-only, preserves source slice, and deduplicates normalized anchors', () => {
    const post = 'Он сказал: “Кот” и кот. Котами гордятся.';
    const prompt = `[Annotate this post:\n${post}]`;
    const result = validateFootnotes({ footnotes: [
        { index: 1, anchor: 'кот', text: '¹ Cat (noun) — explanation' },
        { index: 2, anchor: 'КОТ', text: '² Cat (noun) — duplicate' },
        { index: 3, anchor: 'Коты', text: '³ Cats (noun) — inflection' },
        { index: 4, anchor: 'скот', text: '⁴ Cattle (noun) — boundary' },
    ] }, prompt);
    // The resolved dup ('КОТ') drops; the two misses stay as FLOATING entries
    // (B#3) — the user sees them, they just have no marker.
    assert.deepEqual(result.filter(f => !f.floating).map(f => f.anchor), ['Кот']);
    assert.deepEqual(result.filter(f => f.floating).map(f => f.anchor), ['Коты', 'скот']);
});

test('direct validation accepts typographic exact match and ignores legacy fields', () => {
    const post = 'Он выбрал “мир — здесь”.';
    const prompt = `[Annotate this post:\n${post}]`;
    const result = validateFootnotes({ candidates: ['leak'], footnotes: [
        { anchor: '"мир - здесь"', post_context: 'wrong context', text: '¹ Phrase (text) — kept' },
    ] }, prompt);
    assert.equal(result[0].anchor, '“мир — здесь”');
});

test('forced-ignore is exact on the full resolved anchor', () => {
    const post = 'Кот и котами';
    const prompt = `[Annotate this post:\n${post}]`;
    const result = validateFootnotes({ footnotes: [
        { anchor: 'Кот', text: '¹ Cat (noun) — ignored' },
        { anchor: 'котами', text: '² Cats (noun) — kept' },
    ] }, prompt, ['  КОТ  ']);
    assert.equal(result.length, 1);
    assert.equal(result[0].anchor, 'котами');
});

// ── validateFootnotesAgainstText: the DOM-index-shaped entry point ──

test('against-text validation keeps dash-less footnote texts', () => {
    // The old 'no dash' heuristic dropped any footnote whose text lacked
    // -/–/—; content validity is anchor resolvability, not punctuation.
    const post = 'Натёрла сурьмой глаза.';
    const result = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'глаза', text: '¹ Глаза (анат.) органы зрения' },
    ] }, post);
    assert.equal(result.length, 1);
    assert.equal(result[0].anchor, 'глаза');
});

test('against-text validation can rescue anchors through the fallback resolver', () => {
    const post = 'Натёрла сурьмой глаза.';
    const result = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'сурьма', text: '¹ Сурьма (историч.) — косметика' },
    ] }, post, [], (anchor) => findFuzzySpan(post, anchor));
    assert.equal(result.length, 1);
    // The rescued anchor is rewritten to the verbatim source form, so the
    // exact-only renderer can place the marker later.
    assert.equal(result[0].anchor, 'сурьмой');
});

test('against-text validation keeps unresolvable anchors as floating entries', () => {
    const post = 'Натёрла сурьмой глаза.';
    const result = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'телескоп', text: '¹ Телескоп (опт.) — прибор' },
    ] }, post, [], (anchor) => findFuzzySpan(post, anchor));
    assert.equal(result.length, 1);
    assert.equal(result[0].floating, true);
    assert.equal(result[0].anchor, 'телескоп');
});


test('anchor length cap: 400 passes, 401 drops (PAR-1)', () => {
    const long = 'к'.repeat(200) + ' ' + 'м'.repeat(197);   // 398-char verbatim phrase
    const post = `Начало. ${long} Конец.`;
    const ok = validateFootnotesAgainstText({ footnotes: [{ anchor: long, text: '¹ Длинная фраза.' }] }, post);
    assert.equal(ok.length, 1, 'a long verbatim anchor passes under the 400 cap');
    const tooLong = 'я'.repeat(401);
    const dropped = validateFootnotesAgainstText({ footnotes: [
        { anchor: long, text: '¹ ok.' },
        { anchor: tooLong, text: '² too long.' },
    ] }, post);
    assert.equal(dropped.length, 1, '401 chars still drop');
    assert.equal(dropped[0].anchor, long);
});

test('bracket-strip removes only the group duplicating the anchor (PAR-2)', () => {
    const post = 'Он глядел на гусарский бивуак.';
    const result = validateFootnotesAgainstText({ footnotes: [
        // Anchor duplicated in brackets + a legitimate bracket kept:
        { anchor: 'гусарский бивуак', text: '¹ Бивуак [гусарский бивуак] — см. [прим. переводчика] ниже.' },
    ] }, post, []);
    assert.equal(result.length, 1, 'unfound anchor stays floating, text intact');
    assert.equal(result[0].text, '¹ Бивуак — см. [прим. переводчика] ниже.',
        'only the anchor-duplicating bracket is stripped');
    // Typographic variants of the anchor in brackets collapse too.
    const result2 = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'бивуак', text: '¹ Бивуак [Бивуак] — лагерь.' },
    ] }, 'На бивуаке встали.', []);
    assert.equal(result2[0].text, '¹ Бивуак — лагерь.');
});
