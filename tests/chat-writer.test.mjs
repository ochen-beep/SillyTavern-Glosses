// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for src/infrastructure/chat-writer.js — the coalesced saveChat
// writer footnote payloads persist through. Proves the same contract the
// metadata writer has, retargeted at ctx.saveChat, plus the graceful
// degradation when the host does not expose saveChat.

import './helpers/stub-runtime.mjs';
import { createChatWriter } from '../src/infrastructure/chat-writer.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function makeCtx(chatId, { exposeSaveChat = true } = {}) {
    let saveCount = 0;
    const ctx = {
        chatId,
        saved: () => saveCount,
        saveMetadata() { saveCount++; },
    };
    if (exposeSaveChat) ctx.saveChat = () => { saveCount++; };
    return ctx;
}

test('schedule persists through saveChat (not saveMetadata) after the window', async () => {
    const ctx = makeCtx('chat-A');
    const writer = createChatWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    assert.equal(ctx.saved(), 0);
    await wait(20);
    assert.equal(ctx.saved(), 1);
});

test('rapid payload mutations coalesce into one chat save', async () => {
    const ctx = makeCtx('chat-A');
    const writer = createChatWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    writer.schedule();
    writer.schedule();
    await wait(20);
    assert.equal(ctx.saved(), 1);
});

test('cross-chat safety: a pending chat save is dropped after the chat switches', async () => {
    let ctx = makeCtx('chat-A');
    const writer = createChatWriter({ getContext: () => ctx, debounceMs: 5 });
    writer.schedule();
    ctx = makeCtx('chat-B'); // user switched before the window elapsed
    await wait(20);
    assert.equal(ctx.saved(), 0, 'old chat not saved through the new context');
});

test('flush() persists pending work immediately and settles', async () => {
    const ctx = makeCtx('chat-A');
    const writer = createChatWriter({ getContext: () => ctx, debounceMs: 500 });
    writer.schedule();
    await writer.flush();
    assert.equal(ctx.saved(), 1);
});

test('missing saveChat degrades to a no-op without breaking the chain', async () => {
    const ctx = makeCtx('chat-A', { exposeSaveChat: false });
    const warnings = [];
    const writer = createChatWriter({
        getContext: () => ctx,
        debounceMs: 5,
        onError: (e) => warnings.push(e),
    });
    writer.schedule();
    await wait(20);
    assert.equal(ctx.saved(), 0);
    assert.equal(warnings.length, 0, 'degradation is a warning, not an error');
    // A later flush with a healthy ctx still works.
    const healthy = makeCtx('chat-B');
    const writer2 = createChatWriter({ getContext: () => healthy, debounceMs: 5 });
    writer2.schedule();
    await writer2.flush();
    assert.equal(healthy.saved(), 1);
});
