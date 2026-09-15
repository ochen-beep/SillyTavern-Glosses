// @ts-check
/**
 * Glosses — cache policy unit tests.
 *
 * Pure leaf-count pruning and access-time helpers for the footnote cache,
 * adapted from DS Comments/test/cache-policy.test.mjs to Glosses' flat store
 * shape: { fp: { footnotes, msgId, swipeIdx, timestamp, fp } }.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneCacheEntries, touchCacheEntry } from '../src/cache-policy.js';

const entry = (html, timestamp, fp = `fp:${html}`) => ({ footnotes: [html], timestamp, fp, msgId: '0', swipeIdx: 0 });
const keys = entries => Object.keys(entries).sort();

test('entries at capacity: adding one removes the oldest leaf', () => {
    const entries = {
        'fp:a': entry('a', 10),
        'fp:b': entry('b', 20),
        'fp:c': entry('c', 30),
    };
    const result = pruneCacheEntries(entries, { maxEntries: 3, incoming: 'fp:d' });
    assert.deepEqual(keys(result).sort(), ['fp:b', 'fp:c', 'fp:d']);
});

test('an over-limit legacy store removes only the number needed to make room', () => {
    const entries = {
        'fp:1': entry('a', 1),
        'fp:2': entry('b', 2),
        'fp:3': entry('c', 3),
        'fp:4': entry('d', 4),
    };
    const result = pruneCacheEntries(entries, { maxEntries: 2, incoming: 'fp:5' });
    assert.equal(keys(result).length, 2);
    assert.deepEqual(keys(result).sort(), ['fp:4', 'fp:5']);
});

test('replacing an existing key consumes no new slot', () => {
    const entries = {
        'fp:1': entry('old', 10),
        'fp:2': entry('b', 20),
    };
    const result = pruneCacheEntries(entries, { maxEntries: 2, incoming: 'fp:1' });
    assert.deepEqual(keys(result).sort(), ['fp:1', 'fp:2']);
    assert.equal(result['fp:1'].footnotes[0], 'old', 'existing entry survives replacement');
});

test('protectedEntry is evicted last, but may be removed if required', () => {
    const entries = {
        'fp:protected': entry('protected', 5),
        'fp:older': entry('older', 1),
    };
    // Capacity 2 with a new incoming: protected survives, older evicted.
    const result = pruneCacheEntries(entries, {
        maxEntries: 2, incoming: 'fp:new', protectedEntry: 'fp:protected',
    });
    assert.deepEqual(keys(result).sort(), ['fp:new', 'fp:protected']);

    // Force eviction of the protected entry too.
    const result2 = pruneCacheEntries(entries, {
        maxEntries: 1, incoming: 'fp:new', protectedEntry: 'fp:protected',
    });
    assert.deepEqual(keys(result2).sort(), ['fp:new']);
});

test('missing, NaN and zero timestamps are treated as oldest', () => {
    const entries = {
        'fp:nan': entry('nan', NaN),
        'fp:zero': entry('zero', 0),
        'fp:missing': entry('missing', undefined),
        'fp:finite': entry('finite', 10),
    };
    const result = pruneCacheEntries(entries, { maxEntries: 2, incoming: 'fp:incoming' });
    assert.equal(keys(result).length, 2);
    assert.equal(Object.hasOwn(result, 'fp:finite'), true, 'finite entry survives');
    assert.equal(Object.hasOwn(result, 'fp:incoming'), true, 'incoming slot reserved');
});

test('surviving entry remains unchanged', () => {
    const entries = {
        'fp:keep': entry('keep', 42, 'fp:keep'),
        'fp:drop': entry('drop', 1, 'fp:drop'),
    };
    const result = pruneCacheEntries(entries, { maxEntries: 2, incoming: 'fp:new' });
    assert.deepEqual(result['fp:keep'], {
        footnotes: ['keep'], timestamp: 42, fp: 'fp:keep', msgId: '0', swipeIdx: 0,
    });
});

test('the input object is not mutated (fresh result object)', () => {
    const entries = { 'fp:a': entry('a', 1) };
    const result = pruneCacheEntries(entries, { maxEntries: 1, incoming: 'fp:b' });
    assert.deepEqual(keys(entries).sort(), ['fp:a']);
    assert.notStrictEqual(result, entries);
});

test('pruneCacheEntries validates maxEntries as a positive integer', () => {
    assert.throws(() => pruneCacheEntries({}, { maxEntries: 0, incoming: 'fp:1' }), /maxEntries/);
    assert.throws(() => pruneCacheEntries({}, { maxEntries: NaN, incoming: 'fp:1' }), /maxEntries/);
    assert.throws(() => pruneCacheEntries({}, { maxEntries: 1.5, incoming: 'fp:1' }), /maxEntries/);
});

// ── touchCacheEntry ──

test('touchCacheEntry only changes the target timestamp', () => {
    const entries = {
        'fp:a': entry('a', 10),
        'fp:b': entry('b', 20),
    };
    const result = touchCacheEntry(entries, 'fp:a', 100);
    assert.equal(result['fp:a'].timestamp, 100);
    assert.equal(result['fp:b'].timestamp, 20);
    assert.equal(result['fp:a'].footnotes[0], 'a');
});

test('touchCacheEntry returns the same entries reference (in-place mutation)', () => {
    const entries = { 'fp:a': entry('a', 10) };
    const result = touchCacheEntry(entries, 'fp:a', 100);
    assert.strictEqual(result, entries, 'returns the same ref - zero allocation on hot path');
    assert.equal(entries['fp:a'].timestamp, 100, 'input is mutated in place');
});

test('touchCacheEntry returns original object for missing entry', () => {
    const entries = { 'fp:a': entry('a', 10) };
    const result = touchCacheEntry(entries, 'fp:missing', 100);
    assert.strictEqual(result, entries);
});

test('touchCacheEntry timestamp is monotonic with Math.max(old + 1, accessedAt)', () => {
    const entries = { 'fp:a': entry('a', 100) };
    const result = touchCacheEntry(entries, 'fp:a', 50);
    assert.equal(result['fp:a'].timestamp, 101);
});

test('touched old entry survives the next prune while an untouched entry is evicted', () => {
    const entries = {
        'fp:a': entry('a', 10),
        'fp:b': entry('b', 20),
        'fp:c': entry('c', 30),
    };
    const touched = touchCacheEntry(entries, 'fp:a', 1000);
    const pruned = pruneCacheEntries(touched, { maxEntries: 2, incoming: 'fp:d' });
    assert.deepEqual(keys(pruned).sort(), ['fp:a', 'fp:d']);
});
