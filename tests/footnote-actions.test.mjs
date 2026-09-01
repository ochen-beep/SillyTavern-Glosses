import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for the footnote application-command layer (src/application/footnote-commands.js)
// — the pure data functions editFootnote / deleteFootnote that mutate the per-variant
// payload, re-number survivors, and persist.

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { editFootnote, deleteFootnote } from '../src/application/footnote-commands.js';
import { digestFor, saveFootnotes, getVariantFootnotes } from '../src/cache.js';

function setupChat() {
    const text = 'A sufficiently long AI message body to clear the MIN_POST_LENGTH guard.';
    const msg = makeMessage({ mes: text });
    resetCtx({
        chat: [msg],
        chatId: 'footnote-actions',
        chatMetadata: {},
    });
    const footnotes = [
        { index: 1, anchor: 'foo', text: '¹foo note' },
        { index: 2, anchor: 'bar', text: '²bar note' },
        { index: 3, anchor: 'baz', text: '³baz note' },
    ];
    saveFootnotes('0', 0, footnotes);
    const digest = digestFor('0', 0);
    return { msgId: '0', swipeIdx: 0, digest, footnotes: getVariantFootnotes('0', 0) };
}

// ── editFootnote ──

test('editFootnote updates the matched footnote text in place', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = editFootnote({
        msgId, swipeIdx, digest, footnoteId: 2,
        text: '²completely new text',
    });
    assert.equal(result.ok, true);
    assert.equal(result.footnotes[1].text.startsWith('²'), true);
    assert.equal(result.footnotes[1].text.endsWith('completely new text'), true);
    assert.equal(result.footnotes[0].text.endsWith('foo note'), true);
    assert.equal(result.footnotes[2].text.endsWith('baz note'), true);
    assert.equal(result.footnotes[0].index, 1);
    assert.equal(result.footnotes[2].index, 3);
});

test('editFootnote resolves by footnoteId with stale fn ref', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = editFootnote({
        msgId, swipeIdx, digest,
        fn: { index: 2, anchor: 'bar', text: 'stale-ref' },
        footnoteId: 2,
        text: '²fresh text',
    });
    assert.equal(result.ok, true);
    assert.equal(result.footnotes[1].text.endsWith('fresh text'), true);
});

test('editFootnote rejects empty/whitespace text', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    for (const bad of ['', '   ', '\t\n']) {
        const result = editFootnote({ msgId, swipeIdx, digest, footnoteId: 1, text: bad });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'empty');
    }
});

test('editFootnote aborts when the swipe has changed (stale context)', () => {
    const { msgId, digest } = setupChat();
    globalThis._stCtx.chat[0].swipe_id = 1;
    globalThis._stCtx.chat[0].swipes = ['old swipe text', 'new swipe text'];
    const result = editFootnote({ msgId, swipeIdx: 0, digest, footnoteId: 1, text: '²fresh' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
});

test('editFootnote aborts when validateContext() returns false', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = editFootnote({
        msgId, swipeIdx, digest, footnoteId: 1, text: '²edited',
        validateContext: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
});

test('editFootnote aborts when the footnote is not found', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = editFootnote({ msgId, swipeIdx, digest, footnoteId: 99, text: '²edited' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
});

test('editFootnote returns not-found when the message no longer exists', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    globalThis._stCtx.chat = [];
    const result = editFootnote({ msgId, swipeIdx, digest, footnoteId: 1, text: '²edited' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
});

// ── deleteFootnote ──

test('deleteFootnote removes the footnote and re-numbers survivors', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = deleteFootnote({ msgId, swipeIdx, digest, footnoteId: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.emptied, false);
    const remaining = getVariantFootnotes('0', 0);
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].index, 1);
    assert.equal(remaining[0].text, '¹foo note');
    assert.equal(remaining[1].index, 2);
    assert.equal(remaining[1].text.replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹]+/u, ''), 'baz note');
    assert.equal(remaining[1].text.startsWith('²'), true);
});

test('deleteFootnote clears the variant when only one footnote remains', () => {
    const msg = makeMessage({ mes: 'Only one footnote to delete — clearing should empty the variant.' });
    resetCtx({ chat: [msg], chatId: 'del-test', chatMetadata: {} });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'only', text: '¹only note' }]);
    const digest = digestFor('0', 0);
    const result = deleteFootnote({ msgId: '0', swipeIdx: 0, digest, footnoteId: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.emptied, true);
    assert.equal(getVariantFootnotes('0', 0), null);
});

test('deleteFootnote rejects with stale when the swipe has changed', () => {
    const { msgId, digest } = setupChat();
    globalThis._stCtx.chat[0].swipe_id = 1;
    globalThis._stCtx.chat[0].swipes = ['old', 'new'];
    const result = deleteFootnote({ msgId, swipeIdx: 0, digest, footnoteId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
});

test('deleteFootnote rejects with stale when validateContext() returns false', () => {
    const { msgId, swipeIdx, digest } = setupChat();
    const result = deleteFootnote({
        msgId, swipeIdx, digest, footnoteId: 1,
        validateContext: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
});

test('deleteFootnote returns not-found when chatMetadata is missing entirely', () => {
    resetCtx({ chat: [], chatMetadata: null });
    const result = deleteFootnote({ msgId: '0', swipeIdx: 0, digest: 'abc', footnoteId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
});