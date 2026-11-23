// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// B#3 (owner decision 2026-11-06) — "not found" anchors are no longer dropped:
// they persist as FLOATING footnotes (no marker, "not anchored" badge in the
// panel), so the user sees everything the model returned. dup / empty /
// too-long / forced-ignore still drop — the user's explicit bans and genuine
// garbage are not content. Rebind mirrors the targeted-tab rule: a floating
// entry stays floating on a miss and ANCHORS itself when its phrase appears
// in the edited text; a formerly-anchored entry that still misses is an
// orphan as before.

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { validateFootnotesAgainstText } from '../src/parser.js';
import { rebindFootnotes } from '../src/domain/rebind.js';
import { findFuzzySpan } from '../src/text-index.js';

test('validation keeps an unresolvable anchor as a floating footnote', () => {
    const post = 'Натёрла сурьмой глаза.';
    const result = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'глаза', text: '¹ Глаза — found.' },
        { anchor: 'телескоп', text: '² Телескоп (опт.) — hallucinated.' },
    ] }, post, [], (anchor) => findFuzzySpan(post, anchor));
    assert.equal(result.length, 2, 'nothing dropped — the user sees all');
    const found = result[0];
    assert.equal(found.floating, undefined, 'found entry is not flagged');
    assert.equal(found.anchor, 'глаза');
    const floating = result[1];
    assert.equal(floating.floating, true, 'unfound entry is flagged floating');
    assert.equal(floating.anchor, 'телескоп', 'model anchor kept verbatim');
});

test('floating duplicates and forbidden phrases still drop', () => {
    const post = 'Натёрла сурьмой глаза.';
    const result = validateFootnotesAgainstText({ footnotes: [
        { anchor: 'телескоп', text: '¹ First floating.' },
        { anchor: 'телескоп', text: '² Same phrase — dup floating.' },
        { anchor: 'бинт', text: '³ Forbidden — dropped.' },
    ] }, post, ['бинт']);
    assert.equal(result.length, 1);
    assert.equal(result[0].floating, true);
});

test('rebind keeps floating entries floating on a miss, anchors them on a hit', () => {
    const before = [
        { index: 1, anchor: 'телескоп', text: '¹ Телескоп — floating.', floating: true },
        { index: 2, anchor: 'мост', text: '² Мост — anchored.', prefix: 'p', suffix: 's' },
    ];
    // The anchored phrase ('мост') died in the edit; the floating phrase is
    // still absent: floating stays floating, the anchored one orphans.
    const miss = rebindFootnotes(before, 'Натёрла сурьмой глаза.');
    assert.equal(miss.footnotes.length, 1, 'the anchored footnote orphaned');
    assert.equal(miss.orphans.length, 1);
    assert.equal(miss.footnotes[0].floating, true, 'floating survives a miss');

    // The floating phrase appeared in the edited text: it anchors itself.
    const hit = rebindFootnotes([before[0]], 'На столе лежал телескоп.');
    assert.equal(hit.footnotes.length, 1);
    assert.equal(hit.footnotes[0].floating, undefined, 'flag cleared once anchored');
    assert.ok(hit.footnotes[0].prefix !== undefined, 'context selectors refreshed');
});
