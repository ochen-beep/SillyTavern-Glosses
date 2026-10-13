// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Post-v3.2 message-identity tests: contentDigest, isViableMessageText.
// The legacy compositeHostKey, legacyFingerprint, and entry-store APIs are removed.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import {
    contentDigest, isViableMessageText,
} from '../src/domain/message-identity.js';
import { digestFor, variantIsViable, saveFootnotes, getVariantFootnotes, clearAll, listFootnoteSets, stats } from '../src/cache.js';
import { makeMessage } from './helpers/stub-runtime.mjs';

// ── contentDigest ──

test('contentDigest is stable for identical input', () => {
    assert.equal(contentDigest('hello world'), contentDigest('hello world'));
});

test('contentDigest differs for prefix-colliding messages', () => {
    const sharedPrefix = 'A'.repeat(200);
    const a = sharedPrefix + ' tail A';
    const b = sharedPrefix + ' tail B';
    assert.notEqual(contentDigest(a), contentDigest(b));
});

test('contentDigest NFC-normalizes before hashing', () => {
    const composed = 'café';
    const decomposed = 'cafe\u0301';
    assert.equal(contentDigest(composed), contentDigest(decomposed));
});

test('contentDigest returns empty string for empty input', () => {
    assert.equal(contentDigest(''), '');
    assert.equal(contentDigest(null), '');
    assert.equal(contentDigest(undefined), '');
});

// ── isViableMessageText ──

test('isViableMessageText rejects placeholder, empty, and too-short text', () => {
    assert.equal(isViableMessageText(''), false);
    assert.equal(isViableMessageText('...'), false);
    assert.equal(isViableMessageText('hi'), false);
});

test('isViableMessageText accepts a normal-length body', () => {
    assert.equal(isViableMessageText('A sufficiently long AI message body to clear the guard.'), true);
});

// ── Per-variant payload API (replaces old entry-store tests) ──

test('saveFootnotes → getVariantFootnotes round-trip', () => {
    const msg = makeMessage({ mes: 'A sufficiently long AI message body to clear the guard.', is_user: false });
    resetCtx({ chat: [msg], chatId: 'test-chat' });
    const fns = [{ index: 1, anchor: 'AI', text: '¹Artificial Intelligence' }];
    const ok = saveFootnotes('0', 0, fns);
    assert.equal(ok, true);
    const stored = getVariantFootnotes('0', 0);
    assert.ok(stored);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].anchor, 'AI');
});

test('getVariantFootnotes returns null for non-viable text', () => {
    const msg = makeMessage({ mes: '...', is_user: false });
    resetCtx({ chat: [msg], chatId: 'test-chat' });
    assert.equal(getVariantFootnotes('0', 0), null);
});

test('digestFor returns content digest of variant text', () => {
    const text = 'A sufficiently long AI message body to clear the guard.';
    resetCtx({ chat: [makeMessage({ mes: text })], chatId: 'test-chat' });
    assert.equal(digestFor('0', 0), contentDigest(text));
});

test('variantIsViable rejects placeholder text', () => {
    resetCtx({ chat: [makeMessage({ mes: '...' })], chatId: 'test-chat' });
    assert.equal(variantIsViable('0', 0), false);
});

test('listFootnoteSets returns all verified payloads, newest first', () => {
    const msg0 = makeMessage({ mes: 'A sufficiently long AI message body to clear the guard. zero' });
    const msg1 = makeMessage({ mes: 'A sufficiently long AI message body to clear the guard. one' });
    resetCtx({ chat: [msg0, msg1], chatId: 'test-chat' });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'zero', text: '¹zero note' }]);
    saveFootnotes('1', 0, [{ index: 1, anchor: 'one', text: '¹one note' }]);
    const list = listFootnoteSets();
    assert.equal(list.length, 2);
    assert.equal(list[0].msgId, '1');
    assert.equal(list[1].msgId, '0');
});

test('stats counts entries and footnotes', () => {
    resetCtx({
        chat: [
            makeMessage({ mes: 'A sufficiently long AI message body to clear the guard. zero' }),
            makeMessage({ mes: 'A sufficiently long AI message body to clear the guard. one' }),
        ],
        chatId: 'test-chat',
    });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'a', text: '¹a' }]);
    saveFootnotes('1', 0, [{ index: 1, anchor: 'b', text: '¹b' }, { index: 2, anchor: 'c', text: '²c' }]);
    const s = stats();
    assert.equal(s.entries, 2);
    assert.equal(s.footnotes, 3);
});

test('clearAll wipes all payloads', () => {
    const msg = makeMessage({ mes: 'A sufficiently long AI message body to clear the guard.' });
    resetCtx({ chat: [msg], chatId: 'test-chat' });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'a', text: '¹a' }]);
    assert.ok(getVariantFootnotes('0', 0));
    clearAll();
    assert.equal(getVariantFootnotes('0', 0), null);
});

test('saveFootnotes returns false with no chatId', () => {
    resetCtx({ chat: [makeMessage({ mes: 'A sufficiently long AI message body to clear the guard.' })], chatId: null });
    assert.equal(saveFootnotes('0', 0, [{ index: 1, anchor: 'a', text: '¹a' }]), false);
});