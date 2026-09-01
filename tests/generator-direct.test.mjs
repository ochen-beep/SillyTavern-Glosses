import test from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import {
    DIRECT_FOOTNOTE_CONTRACT,
    buildContextBlocks,
    buildUserPrompt,
    generateFootnotes,
    _testClearApiOverride,
    _testSetApiOverride,
} from '../src/generator.js';
import { digestFor, getVariantFootnotes, listFootnoteSets, saveFootnotes, togglePoolExcluded, saveForcedIgnore } from '../src/cache.js';
import { contentDigest } from '../src/domain/message-identity.js';

const POST = 'Aurelia opened the astrolabe beside the old observatory.';
const EARLIER = 'Earlier reference to Aurelia.';

function setup({ settings = {}, metadata = {} } = {}) {
    resetCtx({
        chat: [
            makeMessage({ mes: EARLIER }),
            makeMessage({ mes: POST }),
        ],
        chatId: 'direct-generation',
        chatMetadata: metadata,
        extensionSettings: { Glosses: settings },
    });
    loadSettings();
}

test('direct contract describes only the footnotes payload', () => {
    assert.match(DIRECT_FOOTNOTE_CONTRACT, /"footnotes":\[/);
    assert.match(DIRECT_FOOTNOTE_CONTRACT, /exactly \{N\}/);
    assert.doesNotMatch(DIRECT_FOOTNOTE_CONTRACT, /candidate pool|PHASE 1|post_context/i);
    assert.doesNotMatch(DIRECT_FOOTNOTE_CONTRACT, /bracket notation in the "text"/);
});

test('context keeps target first, prior advisory before background, and combines forbidden anchors', async () => {
    setup({ settings: { maxFootnotes: 3, contextDepth: 1, stopWords: 'observatory' } });

    // Create a footnote set on message 0 so the advisory pool picks it up
    saveFootnotes('0', 0, [{ index: 1, anchor: 'Aurelia', text: '¹Aurelia — name.' }], { style: 'base' });

    const blocks = await buildContextBlocks(1, 0);
    assert.match(blocks[0], /^\[Annotate this post:/);
    assert.match(blocks[1], /^\[Previously glossed anchors/);
    assert.match(blocks.at(-1), /^\[Forbidden anchors/);
    assert.match(blocks.at(-1), /observatory/);

    const prompt = await buildUserPrompt(1, 0);
    assert.ok(prompt.indexOf('[Annotate this post:') < prompt.indexOf('[ANNOTATOR CONTRACT'));
    assert.ok(prompt.indexOf('[ANNOTATOR CONTRACT') < prompt.indexOf('[Previously glossed anchors'));
    assert.ok(prompt.indexOf('[Previously glossed anchors') < prompt.indexOf('[Earlier in the scene'));
    assert.match(prompt, /exactly 3 distinct footnotes/);
    assert.doesNotMatch(prompt, /candidate pool|PHASE 1|post_context/i);
});

test('direct response is persisted once and forced anchors are rejected', async () => {
    setup({ settings: { maxFootnotes: 3, stopWords: 'astrolabe' } });
    saveForcedIgnore(['old observatory']);
    let calls = 0;
    _testSetApiOverride(async () => {
        calls++;
        return JSON.stringify({ footnotes: [
            { anchor: 'Aurelia', text: '¹ Aurelia (name) — a proper name.' },
            { anchor: 'astrolabe', text: '² Astrolabe (instrument) — an astronomical device.' },
            { anchor: 'old observatory', text: '³ Observatory (place) — a place for observing stars.' },
        ] });
    });

    try {
        await generateFootnotes(1, 0, null);
    } finally {
        _testClearApiOverride();
    }

    assert.equal(calls, 1);
    const fns = getVariantFootnotes(1, 0);
    // Merged read: regular entries come back tagged kind:'fn'.
    assert.deepEqual(fns, [{
        index: 1,
        anchor: 'Aurelia',
        kind: 'fn',
        text: '¹ Aurelia (name) — a proper name.',
    }]);
});

test('direct honest undershoot and legacy payloads both persist without post-context fields', async () => {
    setup({ settings: { maxFootnotes: 4 } });
    _testSetApiOverride(async () => JSON.stringify({
        candidates: ['astrolabe'],
        footnotes: [{
            anchor: 'astrolabe',
            post_context: 'the astrolabe beside',
            text: '¹ Astrolabe (instrument) — an astronomical device.',
        }],
    }));

    try {
        await generateFootnotes(1, 0, null);
    } finally {
        _testClearApiOverride();
    }

    const fns = getVariantFootnotes(1, 0);
    assert.equal(fns.length, 1);
    assert.deepEqual(fns[0], {
        index: 1,
        anchor: 'astrolabe',
        kind: 'fn',
        text: '¹ Astrolabe (instrument) — an astronomical device.',
    });
});

// Regression: the "Already explained" advisory block must surface anchors
// from all verified payloads, regardless of which swipe is active.
test('prior advisory block survives swipe drift', async () => {
    const swipe1Text = 'Earlier reference to Aurelia — a long enough text for viability.';
    resetCtx({
        chat: [
            {
                mes: 'current variant that is long enough for viability check.',
                is_user: false,
                swipe_id: 5,
                swipes: [
                    'variant zero long enough for viability check pass.',
                    swipe1Text,
                    'variant two long enough for viability check too.',
                    'variant three long enough for viability as well.',
                    'variant four long enough for viability check now.',
                    'current variant that is long enough for viability check.',
                ],
                swipe_info: [
                    { extra: {} },
                    { extra: { gls: {
                        schema: 1,
                        contentDigest: contentDigest(swipe1Text),
                        generatedAt: Date.now(),
                        style: '',
                        footnotes: [{ index: 1, anchor: 'Aurelia', text: '¹ Aurelia — name.' }],
                        orphans: [],
                    } } },
                    { extra: {} }, { extra: {} }, { extra: {} }, { extra: {} },
                ],
                extra: {},
            },
            makeMessage({ mes: POST }),
        ],
        chatId: 'swipe-drift',
        chatMetadata: {},
        extensionSettings: { Glosses: {} },
    });
    loadSettings();

    const blocks = await buildContextBlocks(1, 0);
    const priorBlock = blocks.find(b => b.startsWith('[Previously glossed anchors'));
    assert.ok(priorBlock, 'prior advisory block must be present despite swipe drift');
    assert.match(priorBlock, /Aurelia/);
});

// Pool-excluded anchors must NOT appear in the prior block.
test('poolExcluded anchors are hidden from the prior block', async () => {
    setup({ settings: { maxFootnotes: 3 } });

    saveFootnotes('0', 0, [
        { anchor: 'Aurelia', text: '¹ Aurelia — name.' },
        { anchor: 'astrolabe', text: '² Astrolabe — device.' },
    ], { style: 'base' });

    // Both anchors surface initially
    let blocks = await buildContextBlocks(1, 0);
    let priorBlock = blocks.find(b => b.startsWith('[Previously glossed anchors'));
    assert.ok(priorBlock);
    assert.match(priorBlock, /Aurelia/);
    assert.match(priorBlock, /astrolabe/);

    // Hide 'astrolabe' from pool
    togglePoolExcluded('astrolabe', true);

    blocks = await buildContextBlocks(1, 0);
    priorBlock = blocks.find(b => b.startsWith('[Previously glossed anchors'));
    assert.ok(priorBlock);
    assert.match(priorBlock, /Aurelia/);
    assert.doesNotMatch(priorBlock, /astrolabe/, 'hidden anchor must not leak');

    // Footnote is untouched
    const fns = getVariantFootnotes(0, 0);
    assert.equal(fns.length, 2);
    assert.equal(fns.some(f => f.anchor === 'astrolabe'), true);
});