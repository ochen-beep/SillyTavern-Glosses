import { test } from 'node:test';
import assert from 'node:assert/strict';

// Phase 2b test: 4-tier JSON-repair parser.
//
// The prompt asks for strict {"candidates":[...],"footnotes":[...]} JSON, but
// models routinely emit: reasoning blocks, markdown fences, missing/trailing
// commas, bare newlines inside strings, premature truncation, or one corrupt
// footnote that poisons the whole array. These cases verify the escalating
// repair strategy recovers them. Ported scenarios from DS Comments/parser.test.mjs.

import './helpers/stub-runtime.mjs';
import { parseResponse } from '../src/parser.js';

// A clean, valid direct payload — the regression anchor. Byte-identical input
// must parse without invoking any repair tier (so a model that emits clean JSON
// is never accidentally mutated).
const CLEAN = JSON.stringify({
    footnotes: [
        { anchor: 'augmented reality', text: '¹ AR (Tech.) — overlay.' },
        { anchor: 'notification', text: '² Alert (Tech.) — message.' },
    ],
});

function footnotesOf(parsed) {
    return parsed ? parsed.footnotes.map(f => ({ a: f.anchor, t: f.text })) : null;
}

// ── Tier 0: clean input passes through unchanged ──

test('clean valid JSON parses without repair', () => {
    const parsed = parseResponse(CLEAN);
    assert.ok(parsed);
    assert.equal(parsed.footnotes.length, 2);
    assert.equal(parsed.footnotes[0].anchor, 'augmented reality');
});

test('clean JSON is byte-identical through the parser (no mutation)', () => {
    // parseResponse trims/strips but must not alter the embedded JSON semantics.
    const a = parseResponse(CLEAN);
    const b = parseResponse('  \n' + CLEAN + '\n  ');   // surrounding whitespace
    assert.deepEqual(footnotesOf(a), footnotesOf(b));
});

// ── Reasoning-block stripping ──

test('strips <think> block before JSON', () => {
    const raw = '<think>let me reason about this</think>\n' + CLEAN;
    const parsed = parseResponse(raw);
    assert.equal(parsed.footnotes.length, 2);
});

test('strips unpaired <think> open tag (reasoning model mid-stream)', () => {
    const raw = '<think>reasoning continues here without closing' + CLEAN;
    const parsed = parseResponse(raw);
    assert.equal(parsed.footnotes.length, 2);
});

test('strips <thinking> and <reflection> blocks', () => {
    const raw = '<thinking>hmm</thinking><reflection>maybe</reflection>\n' + CLEAN;
    const parsed = parseResponse(raw);
    assert.equal(parsed.footnotes.length, 2);
});

// ── Tier 1: direct parse handles markdown fences & BOM ──

test('strips ```json code fences around the JSON', () => {
    const raw = '```json\n' + CLEAN + '\n```';
    const parsed = parseResponse(raw);
    assert.equal(parsed.footnotes.length, 2);
});

test('strips a leading BOM', () => {
    const raw = '\uFEFF' + CLEAN;
    const parsed = parseResponse(raw);
    assert.equal(parsed.footnotes.length, 2);
});

// ── Tier 2: tryRepairJson — structural fixes ──

test('repairs trailing comma before closing brace', () => {
    const broken = '{"candidates":["a"],"footnotes":[{"anchor":"a","post_context":"x a","text":"¹ a (t) — b",}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed, 'trailing-comma JSON must parse');
    assert.equal(parsed.footnotes.length, 1);
});

test('repairs missing comma between footnotes array elements', () => {
    const broken = '{"candidates":[],"footnotes":[' +
        '{"anchor":"a","post_context":"x a","text":"¹ a (t) — b"}' +
        '{"anchor":"c","post_context":"x c","text":"² c (t) — d"}' +
        ']}';
    const parsed = parseResponse(broken);
    assert.ok(parsed, 'missing-comma JSON must parse');
    assert.equal(parsed.footnotes.length, 2);
});

test('repairs a bare newline inside a string value', () => {
    // Model emitted a literal newline mid-text instead of \n.
    const broken = '{"candidates":[],"footnotes":[{"anchor":"a","post_context":"x a","text":"¹ a — b\nc continues"}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed);
    assert.equal(parsed.footnotes[0].text, '¹ a — b\nc continues');
});

test('repairs a stray form-feed control char inside a string', () => {
    const broken = '{"candidates":[],"footnotes":[{"anchor":"a","post_context":"x a","text":"¹ a — b\u000Cc"}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed);
    assert.ok(parsed.footnotes[0].text.includes('c'));
});

// ── Tier 3: object extraction — one corrupt footnote shouldn't kill the rest ──

test('extracts individual footnote objects when the array structure is corrupt', () => {
    // Array envelope is missing entirely — model emitted two bare footnote
    // objects back-to-back with junk text between them. extractObjectsFromText
    // must scan the text for each {…} and salvage both.
    const broken = 'Here are the footnotes:\n' +
        '{"anchor":"a","post_context":"x a","text":"¹ a (t) — b"}\n\n' +
        '(some commentary)\n' +
        '{"anchor":"c","post_context":"x c","text":"² c (t) — d"}';
    const parsed = parseResponse(broken);
    assert.ok(parsed, 'object extraction must salvage something');
    assert.ok(parsed.footnotes.length >= 2, `expected >=2 footnotes, got ${parsed.footnotes?.length}`);
});

// ── Tier 4: truncated recovery ──

test('recovers a truncated response cut off mid-footnote', () => {
    // Response was cut before the last } and the closing array ].
    const truncated = '{"candidates":[],"footnotes":[' +
        '{"anchor":"a","post_context":"x a","text":"¹ a (t) — b"},' +
        '{"anchor":"c","post_context":"x c","text":"² c (t) — d';
    const parsed = parseResponse(truncated);
    // Truncated recovery salvages at least the complete first footnote.
    assert.ok(parsed);
    assert.ok(parsed.footnotes.length >= 1);
    assert.equal(parsed.footnotes[0].anchor, 'a');
});

// ── Defence: genuinely broken input falls through to text parser / null ──

test('returns null-ish on input with no recoverable JSON or text footnotes', () => {
    const parsed = parseResponse('I cannot help with that.');
    assert.equal(parsed, null);
});

// ── Proxy hard-wrap recovery ──
// Some proxies hard-wrap the raw JSON at a fixed column width, inserting bare
// '\n' anywhere — mid-word inside anchors, mid-KEY ("footnotes\n":). The wrap
// never consumes characters, so deleting the newlines restores the original.
// Detection signal: a '\n' inside a key (models never emit that).
// Real-world capture: gemini_chat proxy, model gemini-4-argon, 2026-11.

test('recovers a proxy hard-wrapped payload (split key + mid-word wraps)', () => {
    const broken = '{"footnotes\n' +
        '":[{"anchor":"Тимоти двинул свой кожаный портфель вправо","text":"¹ Тимо\n' +
        'ти (канон.) — студент, который в\n' +
        ' школе травил Ханну."},{"anchor":"к\n' +
        'лубный свитшот","text":"³ Клубный свитшот — Спортивная ко\n' +
        'фта."}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed, 'hard-wrapped JSON must parse');
    assert.equal(parsed.footnotes.length, 2);
    // Mid-word wrap rejoined without a space…
    assert.equal(parsed.footnotes[0].anchor, 'Тимоти двинул свой кожаный портфель вправо');
    assert.ok(parsed.footnotes[0].text.includes('Тимоти'), 'mid-word wrap must rejoin');
    // …while a wrap point before a real space keeps exactly one space.
    assert.ok(parsed.footnotes[0].text.includes('в школе'), 'preserved space at wrap point');
    assert.equal(parsed.footnotes[1].anchor, 'клубный свитшот');
    assert.ok(parsed.footnotes[1].text.includes('кофта'));
});

test('hard-wrap recovery also fires on the split envelope key only', () => {
    // Even when only the envelope key is split (values intact), the payload
    // must be accepted — previously parsed fine but was rejected because the
    // key was "footnotes\n" instead of "footnotes".
    const broken = '{"footnotes\n":[{"anchor":"a","text":"¹ a (t) — b"}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed);
    assert.equal(parsed.footnotes.length, 1);
    assert.equal(parsed.footnotes[0].anchor, 'a');
});

test('legit bare newline inside a string is NOT de-wrapped when keys are clean', () => {
    // Regression guard: de-wrapping must trigger only on the split-key signal.
    // A model-emitted bare newline with intact keys keeps its newline.
    const broken = '{"footnotes":[{"anchor":"a","text":"¹ a — b\nc continues"}]}';
    const parsed = parseResponse(broken);
    assert.ok(parsed);
    assert.equal(parsed.footnotes[0].text, '¹ a — b\nc continues');
});
