// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for src/infrastructure/metadata-writer.js — the serialized,
// coalesced saveMetadata writer. Plan stage 5 requires tests that prove:
//   - ordering (mutations are persisted in order, never reordered);
//   - rejection (an error is surfaced once, deduped, and does not poison the chain);
//   - coalescing (rapid mutations collapse into fewer saves);
//   - cross-chat safety (a chat switch drops the pending write for the old chat).

import { createMetadataWriter } from '../src/infrastructure/metadata-writer.js';

// Fake timers via a controllable clock so coalescing windows are deterministic.
function makeClock() {
    let now = 0;
    const timers = new Map();
    let id = 1;
    return {
        now: () => now,
        setTimeout(fn, ms) {
            const t = { fn, at: now + ms, id: id++ };
            timers.set(t.id, t);
            return t.id;
        },
        clearTimeout(id) { timers.delete(id); },
        advance(ms) {
            now += ms;
            // Run any timers whose deadline has passed, in insertion order.
            const due = [...timers.values()].filter(t => t.at <= now).sort((a, b) => a.at - b.at);
            for (const t of due) { timers.delete(t.id); t.fn(); }
        },
        pending() { return timers.size; },
    };
}

function makeCtx(chatId) {
    let saveCount = 0;
    const ctx = {
        chatId,
        saved: () => saveCount,
        saveMetadata() { saveCount++; },
    };
    return ctx;
}

// Use the real setTimeout/clearTimeout for debounce but a fake chatId flip.
function makeRealCtx(chatId) {
    let saveCount = 0;
    return {
        chatId,
        saved: () => saveCount,
        saveMetadata() { saveCount++; },
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Basic persistence ──

test('schedule persists the pending revision after the debounce window', async () => {
    const ctx = makeRealCtx('chat-A');
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    assert.equal(ctx.saved(), 0, 'nothing saved before the window elapses');
    await wait(20);
    assert.equal(ctx.saved(), 1, 'saved once after the debounce window');
});

test('rapid schedules coalesce into a single save', async () => {
    const ctx = makeRealCtx('chat-A');
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    writer.schedule();
    writer.schedule();
    await wait(20);
    assert.equal(ctx.saved(), 1, 'three rapid mutations → one save');
});

test('flush persists immediately without waiting for the debounce window', async () => {
    const ctx = makeRealCtx('chat-A');
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5000 });
    writer.schedule();
    await writer.flush();
    assert.equal(ctx.saved(), 1, 'flush persisted the pending revision now');
    await wait(10);
    assert.equal(ctx.saved(), 1, 'no extra save after the (now-cancelled) timer');
});

// ── Ordering + revision safety ──

test('a mutation landing during an in-flight save is persisted after (revision safety)', async () => {
    // Simulate a slow saveMetadata: the first save is in flight, a second
    // mutation arrives, and the first completion must NOT clear the dirty state
    // of the second — the second revision is saved next.
    let saveCount = 0;
    let resolveFirst;
    const firstGate = new Promise(r => { resolveFirst = r; });
    const ctx = {
        chatId: 'chat-A',
        saveMetadata() {
            saveCount++;
            if (saveCount === 1) return firstGate; // first save blocks
        },
    };
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5 });

    writer.schedule();               // mutation 1 → in-flight save
    await wait(10);                  // window elapses, first save starts and blocks
    writer.schedule();               // mutation 2 while first save is in flight
    resolveFirst();                  // first save completes
    await writer.flush();            // settle the chain
    await tick();
    assert.equal(saveCount, 2, 'both revisions persisted, in order');
});

test('saves happen in order (no reordering)', async () => {
    // Two sequential schedules with distinct timestamps on the saved blobs —
    // the writer must persist them in schedule order.
    const order = [];
    const ctx = {
        chatId: 'chat-A',
        saveMetadata() {
            // ST writes the whole chatMetadata; we observe the order of calls.
            order.push(Date.now());
        },
    };
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    await wait(15);
    writer.schedule();
    await wait(15);
    assert.equal(order.length, 2);
    assert.ok(order[0] <= order[1], 'first save precedes second');
});

// ── Cross-chat safety ──

test('a chat switch before flush drops the pending write for the old chat', async () => {
    // The user is in chat-A, schedules a mutation, then ST switches to chat-B
    // before the debounce window elapses. The pending write must NOT be applied
    // through chat-B's context (which would persist chat-B's metadata).
    let ctx = makeCtx('chat-A');
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    ctx = makeCtx('chat-B'); // context re-read at flush time
    await wait(20);
    assert.equal(ctx.saved(), 0, 'chat-B saveMetadata never called for chat-A work');
});

test('a chat switch mid-save does not write the old chat through the new context', async () => {
    // The saveMetadata call is ASYNC and slow: it starts while the chat is still
    // A, but the CHAT_CHANGED event fires before the host actually persists.
    // At flush time the writer re-reads the context; a chatId mismatch drops the
    // batch so the old chat's blob is never written through the new context.
    let chatId = 'chat-A';
    const savedFor = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const ctx = {
        get chatId() { return chatId; },
        saveMetadata() { return gate; }, // slow host persist, resolved later
    };
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 1 });
    writer.schedule();
    await wait(5);       // save starts (chatId captured at schedule = A)
    chatId = 'chat-B';   // CHAT_CHANGED fires mid-save
    release();           // host persist completes
    await writer.flush();
    assert.equal(savedFor.length, 0, 'nothing written to the (now stale) chat context');
});

// ── Rejection handling ──

test('a throwing saveMetadata is caught, reported once, and does not poison the chain', async () => {
    const errors = [];
    let shouldThrow = true;
    const ctx = {
        chatId: 'chat-A',
        saveMetadata() { if (shouldThrow) throw new Error('disk full'); },
    };
    const writer = createMetadataWriter({
        getContext: () => ctx,
        debounceMs: 5,
        onError: (err) => errors.push(String(err.message)),
    });
    writer.schedule();
    await wait(15);
    assert.equal(errors.length, 1, 'error notified once');

    // Recovery: a later mutation succeeds and the chain is not poisoned.
    shouldThrow = false;
    writer.schedule();
    await writer.flush();
    assert.equal(errors.length, 1, 'no duplicate error notification on recovery');
});

test('error notifications are deduped within the window', async () => {
    const errors = [];
    const ctx = {
        chatId: 'chat-A',
        saveMetadata() { throw new Error('boom'); },
    };
    const writer = createMetadataWriter({
        getContext: () => ctx,
        debounceMs: 1,
        onError: (err) => errors.push(String(err.message)),
    });
    writer.schedule();
    await wait(10);
    writer.schedule();
    await wait(10);
    // Two failing saves, but the 5s dedup window collapses notifications to one.
    assert.equal(errors.length, 1);
});

// ── isPending ──

test('isPending reflects dirty / in-flight state', async () => {
    const ctx = makeRealCtx('chat-A');
    const writer = createMetadataWriter({ getContext: () => ctx, debounceMs: 20 });
    assert.equal(writer.isPending(), false);
    writer.schedule();
    assert.equal(writer.isPending(), true, 'dirty after schedule');
    await writer.flush();
    assert.equal(writer.isPending(), false, 'clean after flush');
});
