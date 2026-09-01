// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plan stage 6 tests — scoped generation ownership.
// Updated for per-variant payload storage (v3.2).

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import {
    generateFootnotes, _testSetApiOverride, _testClearApiOverride,
} from '../src/generator.js';
import { generationCoordinator } from '../src/application/generation-coordinator.js';
import { getVariantFootnotes, listFootnoteSets } from '../src/cache.js';

const POST_A = 'Aurelia opened the astrolabe beside the old observatory.';
const POST_B = 'Mikhail charted the Meridian arc across the frozen steppe.';

const RAW_A = JSON.stringify({
    candidates: ['astrolabe'],
    footnotes: [{ anchor: 'astrolabe', text: '¹ Astrolabe (Instr.) — measuring instrument.' }],
});
const RAW_B = JSON.stringify({
    candidates: ['Meridian'],
    footnotes: [{ anchor: 'Meridian', text: '¹ Meridian (Geogr.) — longitude reference line.' }],
});

function setup() {
    resetCtx({
        chat: [
            makeMessage({ mes: POST_A }),
            makeMessage({ mes: POST_B }),
        ],
        chatId: 'coordinator-test',
        chatMetadata: {},
        extensionSettings: { Glosses: {} },
    });
    loadSettings();
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ── Scoped invalidation: swipe of A does not kill B ──

test('swiping one message does not discard an unrelated message generation', async () => {
    setup();
    let resolveB;
    const gateB = new Promise(r => { resolveB = r; });

    _testSetApiOverride(() => gateB);
    const pB = generateFootnotes('1', 0, null);
    await tick();

    generationCoordinator.bumpMessageRevision('0');
    assert.equal(state.generationEpoch, 0, 'global epoch untouched by a swipe');

    resolveB(RAW_B);
    await pB;

    const sets = listFootnoteSets();
    const bSet = sets.find(s => s.msgId === '1');
    assert.ok(bSet, 'B generation committed despite A being swiped');
    assert.equal(bSet.footnotes[0].anchor, 'Meridian');

    _testClearApiOverride();
});

// ── Ownership guard: superseded run must not commit ──

test('a superseded run does not commit even when its transport ignores AbortSignal', async () => {
    setup();
    let resolveA;
    const gateA = new Promise(r => { resolveA = r; });
    _testSetApiOverride(() => gateA);

    const pA = generateFootnotes('0', 0, null);
    await tick();

    _testSetApiOverride(() => Promise.resolve(RAW_A));
    const pB = generateFootnotes('0', 0, null);
    await tick();
    await pB;

    resolveA(RAW_A);
    await pA;

    const sets = listFootnoteSets().filter(s => s.msgId === '0');
    assert.equal(sets.length, 1, 'only the superseding run committed');

    _testClearApiOverride();
});

// ── Global invalidation on chat change ──

test('chat change (invalidateAll) discards every in-flight generation', async () => {
    setup();
    const pending = new Map();
    _testSetApiOverride((_s, userPrompt) => {
        return new Promise((res) => {
            const id = String(userPrompt).includes(POST_B) ? 'B' : 'A';
            pending.set(id, res);
        });
    });
    const pA = generateFootnotes('0', 0, null);
    const pB = generateFootnotes('1', 0, null);
    await tick();

    generationCoordinator.invalidateAll();

    pending.get('A')?.(RAW_A);
    pending.get('B')?.(RAW_B);
    await Promise.all([pA, pB]);

    assert.equal(listFootnoteSets().length, 0,
        'no generation commits after a chat change');

    _testClearApiOverride();
});

// ── Coordinator primitives ──

test('beginRun supersedes a previous run for the same message', () => {
    setup();
    const run1 = generationCoordinator.beginRun('0');
    const run2 = generationCoordinator.beginRun('0');
    assert.equal(generationCoordinator.isCurrent(run1), false);
    assert.equal(generationCoordinator.isCurrent(run2), true);
    assert.equal(state.abortControllers['0'], run2.ctrl);
});

test('endRun only cleans up when the run is still the owner', () => {
    setup();
    const run1 = generationCoordinator.beginRun('0');
    const run2 = generationCoordinator.beginRun('0');
    assert.equal(generationCoordinator.endRun(run1), false);
    assert.equal(state.abortControllers['0'], run2.ctrl);
    assert.equal(generationCoordinator.endRun(run2), true);
    assert.equal(state.abortControllers['0'], undefined);
});