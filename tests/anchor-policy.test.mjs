import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExplainedAnchors, combineForbiddenAnchors, normalizeForcedIgnore } from '../src/anchor-policy.js';

function setFor(msgId, footnotes) {
    return { msgId, swipeIdx: 0, footnotes };
}

test('collectExplainedAnchors dedups by normalized key, newest message first', () => {
    const sets = [
        setFor('0', [{ anchor: 'Same' }]),
        setFor('5', [{ anchor: 'same' }, { anchor: 'Other' }]),
    ];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 9 }), ['same', 'Other']);
});

test('collectExplainedAnchors respects the limit', () => {
    const sets = [
        setFor('0', [{ anchor: 'A' }]),
        setFor('1', [{ anchor: 'B' }]),
        setFor('2', [{ anchor: 'C' }]),
    ];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 9, limit: 2 }), ['C', 'B']);
});

test('collectExplainedAnchors excludes only the current message anchors', () => {
    const sets = [
        setFor('2', [{ anchor: 'Prev' }]),
        setFor('3', [{ anchor: 'Current' }]),
    ];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 3 }), ['Prev']);
});

test('collectExplainedAnchors includes anchors from all messages except current', () => {
    const sets = [
        setFor('1', [{ anchor: 'One' }]),
        setFor('3', [{ anchor: 'Three' }]),
        setFor('5', [{ anchor: 'Five' }]),
    ];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 3 }), ['Five', 'One']);
});

test('collectExplainedAnchors ignores empty/non-anchor footnotes and missing sets', () => {
    const sets = [
        setFor('0', [{ anchor: '' }, { anchor: '   ' }, {}]),
        setFor('1', []),
    ];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 5 }), []);
    assert.deepEqual(collectExplainedAnchors({ sets: null, currentMsgId: 5 }), []);
    assert.deepEqual(collectExplainedAnchors({ sets: [], currentMsgId: 5 }), []);
});

test('collectExplainedAnchors drops anchors whose normalized key is in excludeKeys', () => {
    const sets = [
        setFor('0', [{ anchor: 'Astrolabe' }]),
        setFor('1', [{ anchor: 'Marshall' }, { anchor: 'Kohl' }]),
    ];
    assert.deepEqual(
        collectExplainedAnchors({ sets, currentMsgId: 9, excludeKeys: ['astrolabe', 'marshall'] }),
        ['Kohl'],
    );
});

test('collectExplainedAnchors excludeKeys is optional and accepts non-array gracefully', () => {
    const sets = [setFor('0', [{ anchor: 'Astrolabe' }])];
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 9 }), ['Astrolabe']);
    assert.deepEqual(collectExplainedAnchors({ sets, currentMsgId: 9, excludeKeys: 'astrolabe' }), ['Astrolabe']);
});

test('forced ignores preserve the first spelling and combine with stop words', () => {
    assert.deepEqual(normalizeForcedIgnore(['  Кот ', 'кот', '', 'Dog']), ['Кот', 'Dog']);
    assert.deepEqual(combineForbiddenAnchors(['DOG'], ['dog', 'Кот']), ['DOG', 'Кот']);
});