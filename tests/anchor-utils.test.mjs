import test from 'node:test';
import assert from 'node:assert/strict';
import { findAllAnchorSpans, findAnchorInText, normalizeAnchorKey } from '../src/anchor-utils.js';

test('normalizeAnchorKey applies NFC, case, typography, dashes, and whitespace rules', () => {
    assert.equal(normalizeAnchorKey('  Cafe\u0301\t“Hello” – world  '), 'café "hello" - world');
});

test('findAnchorInText returns the original source slice and UTF-16 span', () => {
    const source = 'Before  «Hello\nworld»; after.';
    const hit = findAnchorInText(source, '"hello world"');
    assert.deepEqual(hit, { text: '«Hello\nworld»', start: 8, end: 21 });
});

test('matching is case insensitive and respects Unicode word boundaries', () => {
    assert.equal(findAnchorInText('скот кот, КОТ.', 'кот')?.text, 'кот');
    assert.equal(findAnchorInText('скот', 'кот'), null);
    assert.equal(findAnchorInText('кот2', 'кот'), null);
});

test('findAllAnchorSpans returns all non-overlapping occurrences', () => {
    assert.deepEqual(findAllAnchorSpans('Cat, cat, catalog, CAT', 'cat').map(({ text, start, end }) => ({ text, start, end })), [
        { text: 'Cat', start: 0, end: 3 },
        { text: 'cat', start: 5, end: 8 },
        { text: 'CAT', start: 19, end: 22 },
    ]);
});

test('astral chars before an anchor do not desync the position map', () => {
    // An emoji is one map unit but two UTF-16 code units; string indexOf
    // speaks code units, so a per-code-point map read desyncs by one per
    // emoji and the anchor after it silently stops matching.
    assert.deepEqual(
        { ...findAnchorInText('😀😀 фонарь над мостом', 'фонарь') },
        { text: 'фонарь', start: 5, end: 11 },
    );
    assert.deepEqual(
        { ...findAnchorInText('👩‍🦰 рыжая фонарь', 'фонарь') },
        { text: 'фонарь', start: 12, end: 18 },
    );
    assert.deepEqual(
        { ...findAnchorInText('𝕬𝖇𝖈 фонарь тут', 'фонарь') },
        { text: 'фонарь', start: 7, end: 13 },
    );
});

test('occurrences after an emoji are still found by the span sweep', () => {
    const spans = findAllAnchorSpans('фонарь 😀 фонарь и фонарь', 'фонарь');
    assert.deepEqual(spans.map(({ start, end }) => [start, end]), [[0, 6], [10, 16], [19, 25]]);
});

test('typographic ellipsis in the post matches ASCII dots in the anchor (both ways)', () => {
    // B#2 (user report 2026-11-06): the post carries … (U+2026, one char) while
    // models routinely re-quote it as three ASCII dots — the anchor then drops
    // as "not found" before any cap logic, and the fuzzy tier cannot rescue
    // long anchors (word cap 12). Both directions must canonicalize.
    const post = 'înseamnă că până duminică mândra contesă va prinde de veste, și atunci vor fi siliți să…';
    const anchor = 'și atunci vor fi siliți să...';
    const hit = findAnchorInText(post, anchor);
    assert.ok(hit, 'ASCII-dot anchor must match an ellipsis post');
    assert.equal(hit.text, 'și atunci vor fi siliți să…', 'the resolved text is the verbatim source slice');
    // Reverse direction: anchor quotes the typographic char, post has dots.
    const dottedPost = 'se așteaptă ca vor fi siliți să... și va fi vizibil';
    const ellipsisAnchor = 'ca vor fi siliți să… și va';
    assert.ok(findAnchorInText(dottedPost, ellipsisAnchor),
        'ellipsis anchor must match an ASCII-dot post');
    assert.equal(normalizeAnchorKey('să…'), normalizeAnchorKey('să...'), 'keys collide as the same anchor');
});
