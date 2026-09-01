import { test } from 'node:test';
import assert from 'node:assert/strict';

// Phase 2a test: generation-epoch staleness guard.
// Updated for per-variant payload storage (v3.2).

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import {
    state, bumpGenerationEpoch, beginGenerationEpoch, isEpochCurrent,
} from '../src/core.js';
import {
    generateFootnotes, _testSetApiOverride, _testClearApiOverride,
} from '../src/generator.js';
import { digestFor, getVariantFootnotes, listFootnoteSets } from '../src/cache.js';

const POST_TEXT = 'The augmented reality glasses displayed a notification.';
const RAW_RESPONSE = JSON.stringify({
    candidates: ['augmented reality glasses', 'notification'],
    footnotes: [
        { anchor: 'augmented reality glasses', post_context: 'The augmented reality glasses', text: '¹ AR glasses (Tech.) — wearable computing.' },
    ],
});

async function setupChat() {
    resetCtx({
        chat: [makeMessage({ mes: POST_TEXT })],
        chatMetadata: {},
        chatId: 'chat-A',
    });
    const { loadSettings } = await import('../src/core.js');
    loadSettings();
}

test('epoch guard primitives: bump invalidates a snapshot', () => {
    const tok = beginGenerationEpoch();
    assert.equal(isEpochCurrent(tok), true);
    bumpGenerationEpoch();
    assert.equal(isEpochCurrent(tok), false);
    const tok2 = beginGenerationEpoch();
    assert.equal(isEpochCurrent(tok2), true);
});

test('bumpGenerationEpoch increments by exactly 1', () => {
    state.generationEpoch = 0;
    bumpGenerationEpoch();
    assert.equal(state.generationEpoch, 1);
    bumpGenerationEpoch();
    assert.equal(state.generationEpoch, 2);
});

test('a result completed after CHAT_CHANGED is NOT stored (stale discard)', async () => {
    await setupChat();
    let resolveApi;
    const apiPromise = new Promise(resolve => { resolveApi = resolve; });
    _testSetApiOverride(() => apiPromise);

    const p = generateFootnotes('0', 0, null);

    await Promise.resolve();
    bumpGenerationEpoch();

    resolveApi(RAW_RESPONSE);
    await p;

    assert.equal(listFootnoteSets().length, 0,
        'stale generation result must not be persisted after a chat switch');

    _testClearApiOverride();
});

test('a result completed in the same epoch IS stored', async () => {
    await setupChat();
    _testSetApiOverride(() => Promise.resolve(RAW_RESPONSE));
    await generateFootnotes('0', 0, null);

    const sets = listFootnoteSets();
    assert.equal(sets.length, 1, 'a same-epoch result must be persisted');
    assert.ok(sets[0].footnotes.length >= 1);
    assert.equal(sets[0].footnotes[0].post_context, undefined);

    _testClearApiOverride();
});

test('a result completed after an in-place message edit is NOT stored', async () => {
    await setupChat();
    let resolveApi;
    const apiPromise = new Promise(resolve => { resolveApi = resolve; });
    _testSetApiOverride(() => apiPromise);

    const pending = generateFootnotes('0', 0, null);
    await Promise.resolve();
    globalThis._stCtx.chat[0].mes = 'The revised post contains a different subject.';
    globalThis._stCtx.chat[0].swipes[0] = globalThis._stCtx.chat[0].mes;
    resolveApi(RAW_RESPONSE);
    await pending;

    assert.equal(listFootnoteSets().length, 0,
        'an in-place edit must invalidate the generation');
    _testClearApiOverride();
});