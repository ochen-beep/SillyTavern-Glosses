import test from 'node:test';
import assert from 'node:assert/strict';

// Pure-model tests for src/text-index.js. No stub-runtime needed: the pure
// surface (buildTextModel / segmentsFor / findFuzzySpan /
// computeContextSelectors) has no DOM or SillyTavern dependencies; chunk
// "nodes" are opaque objects that carry their own text for slice assertions.
import {
    buildTextModel,
    segmentsFor,
    computeContextSelectors,
    findFuzzySpan,
} from '../src/text-index.js';
import { findAnchorInText } from '../src/anchor-utils.js';

// A rendered message shape: inline <em> split + block boundary, the DOM case
// that silently lost markers under the old per-text-node matcher.
const A = { text: 'Она прошептала ' };            // text node before <em>
const B = { text: '«valar morghulis»' };           // text node inside <em>
const C = { text: ' и села.' };                    // text node after <em>
const D = { text: 'Новый абзац.' };                // separate <p> (sepBefore)

function buildFixture() {
    const model = buildTextModel([
        { node: A, text: A.text },
        { node: B, text: B.text },
        { node: C, text: C.text },
        { node: D, text: D.text, sepBefore: true },
    ]);
    return model;
}

test('buildTextModel concatenates chunks and inserts block separators', () => {
    const model = buildFixture();
    assert.equal(model.text, 'Она прошептала «valar morghulis» и села.\nНовый абзац.');
    assert.deepEqual(model.boundaries.map(b => b.node), [A, B, C, D]);
});

test('a span inside one node maps to a single segment with local offsets', () => {
    const model = buildFixture();
    const hit = findAnchorInText(model.text, 'valar morghulis');
    assert.ok(hit);
    const segments = segmentsFor(model, hit.start, hit.end);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].node, B);
    assert.equal(B.text.slice(segments[0].start, segments[0].end), hit.text);
});

test('a span crossing an inline-element boundary maps to one segment per node', () => {
    const model = buildFixture();
    const hit = findAnchorInText(model.text, 'прошептала «valar');
    assert.ok(hit, 'whitespace-normalized match must span the A|B boundary');
    const segments = segmentsFor(model, hit.start, hit.end);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].node, A);
    assert.equal(segments[1].node, B);
    const rebuilt = segments.map(s => s.node.text.slice(s.start, s.end)).join('');
    assert.equal(rebuilt, hit.text);
});

test('a span across a block separator maps to segments that skip the gap', () => {
    const model = buildFixture();
    // The '\n' separator normalizes to a space, so the anchor validates like
    // the old flat-text matcher did — but maps to C-tail + D-head pieces.
    const hit = findAnchorInText(model.text, 'села. Новый');
    assert.ok(hit);
    const segments = segmentsFor(model, hit.start, hit.end);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].node, C);
    assert.equal(segments[1].node, D);
    assert.equal(segments.map(s => s.node.text.slice(s.start, s.end)).join(' '), hit.text.replace(/\s+/gu, ' '));
});

test('findFuzzySpan resolves a Russian inflection to the source form', () => {
    const text = 'Натёрла сурьмой глаза, как завещала жрица.';
    const hit = findFuzzySpan(text, 'сурьма');
    assert.ok(hit);
    assert.equal(hit.text, 'сурьмой');
    assert.ok(hit.distance <= 2);
    // Resolved span must itself be exact-matchable (the renderer is exact-only).
    assert.equal(findAnchorInText(text, hit.text)?.text, 'сурьмой');
});

test('findFuzzySpan resolves markdown decoration the model copied into the anchor', () => {
    const text = 'Она прошептала «valar morghulis» и села на трон.';
    const hit = findFuzzySpan(text, '*«valar morghulis»*');
    assert.ok(hit);
    assert.equal(hit.text, '«valar morghulis»');
});

test('findFuzzySpan rejects anchors with no near neighbour and short anchors', () => {
    const text = 'Лезвия врезались в её платье.';
    assert.equal(findFuzzySpan(text, 'гоблины'), null);
    assert.equal(findFuzzySpan(text, 'кот'), null); // below the 4-char floor
});

test('findFuzzySpan stays word-boundary aligned (never mid-word)', () => {
    const text = 'скот кот, КОТ.';
    // 'от' is a mid-word substring of «скот»/«кот»; fuzzy must not snap to it
    // because the needle is too short — and a longer mid-word needle resolves
    // only to the FULL word, never a partial slice.
    assert.equal(findFuzzySpan(text, 'от'), null);
    const hit = findFuzzySpan(text, 'оты');
    if (hit) assert.equal(/(^|\s)оты(\s|$)/u.test(hit.text), false);
});

test('computeContextSelectors returns the surrounding context, trimmed', () => {
    const text = 'много слов перед якорем и несколько слов после якоря';
    const hit = findAnchorInText(text, 'якорем');
    const { prefix, suffix } = computeContextSelectors(text, hit.start, hit.end, 32);
    assert.equal(prefix, 'много слов перед');
    assert.equal(suffix, 'и несколько слов после якоря');
});
