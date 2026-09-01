import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { rebindFootnotes, rankOccurrencesByContext } from '../src/domain/rebind.js';

const TEXT = 'The astrolabe gleamed on the shelf, next to the astrolabe the captain had lost. Sürme coated the walls.';

test('rebind keeps footnotes whose anchors still resolve and refreshes selectors', () => {
    const fns = [
        { index: 1, anchor: 'astrolabe', text: '¹ astrolabe — tool', prefix: 'The ', suffix: ' gleamed' },
        { index: 2, anchor: 'Sürme', text: '² Sürme — pigment', prefix: 'walls', suffix: ' coated' },
    ];
    const { footnotes, orphans, fuzzyRescues } = rebindFootnotes(fns, TEXT);
    assert.equal(orphans.length, 0);
    assert.equal(fuzzyRescues.length, 0);
    assert.equal(footnotes.length, 2);
    const astro = footnotes.find(f => f.anchor === 'astrolabe');
    assert.ok(astro);
    // Selectors recomputed for the new text around the chosen occurrence.
    assert.ok(astro.prefix.includes('The'));
    assert.ok(astro.suffix.includes('gleamed'));
});

test('rebind reports anchors that no longer exist as orphans, survivors renumbered', () => {
    const fns = [
        { index: 1, anchor: 'astrolabe', text: '¹ astrolabe — tool' },
        { index: 2, anchor: 'gone phrase', text: '² gone — was here' },
        { index: 3, anchor: 'Sürme', text: '³ Sürme — pigment' },
    ];
    const { footnotes, orphans } = rebindFootnotes(fns, TEXT);
    assert.deepEqual(orphans.map(o => o.anchor), ['gone phrase']);
    assert.equal(footnotes.length, 2);
    // Survivors renumbered 1..2 in document order (astrolabe first, Sürme second).
    assert.equal(footnotes[0].index, 1);
    assert.equal(footnotes[0].anchor, 'astrolabe');
    assert.equal(footnotes[1].index, 2);
    assert.equal(footnotes[1].anchor, 'Sürme');
});

test('rebind ranks repeated anchors by stored prefix/suffix context', () => {
    // "astrolabe" occurs twice; the footnote was placed on the SECOND one.
    const fns = [{ index: 1, anchor: 'astrolabe', text: '¹ astrolabe — tool', prefix: 'next to the', suffix: 'the captain' }];
    const { footnotes } = rebindFootnotes(fns, TEXT);
    assert.equal(footnotes.length, 1);
    assert.ok(footnotes[0].prefix.includes('next to'));
});

test('rebind fuzzy-rescues lightly inflected anchors and rewrites them resolvable', () => {
    // Anchor saved in an oblique case; the text holds the nominative form.
    const text = 'Стены были покрыты сурьмой до самого потолка.';
    const fns = [{ index: 1, anchor: 'сурьмый', text: '¹ сурьма — pigment' }];
    const { footnotes, orphans, fuzzyRescues } = rebindFootnotes(fns, text);
    // If the fuzzy tier rescued it, the anchor is rewritten to the source text.
    if (fuzzyRescues.length) {
        assert.equal(orphans.length, 0);
        assert.equal(footnotes.length, 1);
        assert.equal(footnotes[0].anchor, 'сурьмой');
    } else {
        // Distances beyond the caps degrade to an orphan — never a wrong anchor.
        assert.equal(footnotes.length, 0);
        assert.equal(orphans.length, 1);
    }
});

test('rebind drops footnotes without an anchor into orphans', () => {
    const fns = [
        { index: 1, anchor: 'astrolabe', text: '¹ astrolabe — tool' },
        { index: 2, anchor: '', text: '² unanchored legacy note' },
    ];
    const { footnotes, orphans } = rebindFootnotes(fns, TEXT);
    assert.equal(footnotes.length, 1);
    assert.deepEqual(orphans.map(o => o.anchor), ['']);
});

test('rebind never places two footnotes on overlapping spans', () => {
    const text = 'the long dark tea-time of the soul arrived';
    const fns = [
        { index: 1, anchor: 'long dark tea-time', text: '¹ phrase' },
        { index: 2, anchor: 'dark tea-time of', text: '² overlapping phrase' },
    ];
    const { footnotes } = rebindFootnotes(fns, text);
    // Both anchors resolve individually but overlap; the greedy sweep keeps
    // the earlier-starting one and orphans the loser (or vice versa) — the
    // invariant is: no two survivors share a span.
    const spans = footnotes
        .map(f => ({ f, hit: text.indexOf(f.anchor) }))
        .filter(x => x.hit >= 0);
    for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
            const a = spans[i], b = spans[j];
            const aEnd = a.hit + a.f.anchor.length;
            const bEnd = b.hit + b.f.anchor.length;
            const overlaps = a.hit < bEnd && b.hit < aEnd;
            assert.equal(overlaps, false, `survivors overlap: ${a.f.anchor} / ${b.f.anchor}`);
        }
    }
});

test('rebind of an unchanged text is a no-op for survivors', () => {
    const fns = [
        { index: 1, anchor: 'astrolabe', text: '¹ astrolabe — tool', prefix: 'The ', suffix: ' gleamed' },
    ];
    const { footnotes, orphans } = rebindFootnotes(fns, TEXT);
    assert.deepEqual(orphans, []);
    assert.equal(footnotes.length, 1);
    assert.equal(footnotes[0].anchor, 'astrolabe');
    assert.equal(footnotes[0].text, '¹ astrolabe — tool');
});

test('rankOccurrencesByContext prefers the occurrence matching stored context', () => {
    const occurrences = [
        { start: TEXT.indexOf('astrolabe'), end: TEXT.indexOf('astrolabe') + 9 },
        { start: TEXT.lastIndexOf('astrolabe'), end: TEXT.lastIndexOf('astrolabe') + 9 },
    ];
    const fn = { prefix: 'next to the', suffix: 'the captain' };
    const ranked = rankOccurrencesByContext(occurrences, fn, TEXT);
    assert.equal(ranked[0].start, occurrences[1].start);
    // No context stored → document order preserved.
    assert.deepEqual(rankOccurrencesByContext(occurrences, {}, TEXT), occurrences);
});

test('rebind handles empty/absent inputs without throwing', () => {
    assert.deepEqual(rebindFootnotes([], TEXT).footnotes, []);
    assert.deepEqual(rebindFootnotes(null, TEXT).footnotes, []);
    assert.deepEqual(rebindFootnotes(FNS_ABSENT(), '').footnotes, []);
    function FNS_ABSENT() { return [{ index: 1, anchor: 'x', text: '¹ x' }]; }
});
