import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for src/ui/clipboard.js — the honest-result copy helper.
//
// The four paths copyText() must distinguish (regression: the old
// `await navigator.clipboard?.writeText()` resolved to undefined on insecure
// origins and callers showed a false "Copied ✓"):
//   1. Clipboard API present + resolves  → true, fallback never runs.
//   2. API missing (insecure origin)     → fallback decides.
//   3. API present but rejects           → fallback decides.
//   4. Both paths fail                    → false.
//
// The DOM execCommand fallback needs a real document, so tests inject stubs.

import { copyText } from '../src/ui/clipboard.js';

const boom = () => { throw new Error('fallback must not run'); };

test('copyText resolves true through the Clipboard API without touching the fallback', async () => {
    const calls = [];
    const ok = await copyText('note text', {
        clipboard: { writeText: async (t) => { calls.push(t); } },
        fallback: boom,
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, ['note text']);
});

test('copyText degrades to the fallback when the API is missing (insecure origin)', async () => {
    const seen = [];
    const ok = await copyText('note text', {
        clipboard: undefined,
        fallback: (t) => { seen.push(t); return true; },
    });
    assert.equal(ok, true);
    assert.deepEqual(seen, ['note text']);
});

test('copyText degrades to the fallback when the API rejects', async () => {
    const ok = await copyText('note text', {
        clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } },
        fallback: () => true,
    });
    assert.equal(ok, true);
});

test('copyText resolves false when both paths fail', async () => {
    const ok = await copyText('note text', { clipboard: null, fallback: () => false });
    assert.equal(ok, false);
});

test('copyText resolves false when the fallback throws', async () => {
    const ok = await copyText('note text', {
        clipboard: null,
        fallback: () => { throw new Error('execCommand unavailable'); },
    });
    assert.equal(ok, false);
});

test('copyText ignores a clipboard object without a callable writeText', async () => {
    // navigator.clipboard exists but is crippled (no writeText) — must not be
    // called, and the fallback decides.
    let called = false;
    const ok = await copyText('note text', {
        clipboard: { get: () => { called = true; } },
        fallback: () => true,
    });
    assert.equal(ok, true);
    assert.equal(called, false);
});
