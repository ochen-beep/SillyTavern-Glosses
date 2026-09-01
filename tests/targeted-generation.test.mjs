import test from 'node:test';
import assert from 'node:assert/strict';
import '../tests/helpers/stub-runtime.mjs';
import { parseTargetLines, validateTargetedResponse, buildTargetedPrompt, generateTargetedFootnotes, clearTargetedState } from '../src/targeted-generation.js';
import { beginGenerationEpoch, bumpGenerationEpoch } from '../src/core.js';

test('target lines trim, deduplicate, and cap at twenty', () => {
    const result = parseTargetLines([' Alpha ', 'alpha', ...Array.from({ length: 21 }, (_, i) => `term ${i}`), ''].join('\n'));
    assert.equal(result.targets[0], 'Alpha');
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.targets.length, 20);
    assert.equal(result.truncatedCount, 2);
});

test('targeted response is reordered, constrained, and reports missing/invalid', () => {
    const result = validateTargetedResponse({ footnotes: [
        { anchor: 'second', text: '² Second — explanation' },
        { anchor: 'extra', text: 'Extra' },
        { anchor: 'second', text: 'Duplicate' },
    ] }, ['first', 'second']);
    assert.deepEqual(result.footnotes.map(f => f.anchor), ['second']);
    // Targeted bodies are stored WITHOUT a numeric prefix — the symbol marker
    // is derived from position at render time, never from digits.
    assert.equal(result.footnotes[0].text, 'Second — explanation');
    assert.deepEqual(result.missingTargets, ['first']);
    assert.equal(result.invalidCount, 2);
});

test('target prompt makes submitted targets authoritative', () => {
    const prompt = buildTargetedPrompt({ targets: ['not in post'], outputLanguage: 'English' });
    assert.match(prompt, /not in post/);
    assert.match(prompt, /need not occur/);
    assert.doesNotMatch(prompt, /candidate pool/i);
});

test('targeted generation uses request and does not persist', async () => {
    let calls = 0;
    const result = await generateTargetedFootnotes({
        targets: ['term'],
        request: async (_system, user, signal) => {
            calls++;
            assert.match(user, /term/);
            assert.equal(signal.aborted, false);
            return JSON.stringify({ footnotes: [{ anchor: 'term', text: '¹ Term — meaning' }] });
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.footnotes.map(f => f.anchor), ['term']);
    assert.deepEqual(globalThis._stCtx.chatMetadata, {});
    clearTargetedState();
});

test('new targeted request makes prior request stale', async () => {
    let release;
    const first = generateTargetedFootnotes({ targets: ['one'], request: (_s, _u, signal) => new Promise(resolve => {
        release = () => resolve(JSON.stringify({ footnotes: [{ anchor: 'one', text: 'One' }] }));
        signal.addEventListener('abort', () => {});
    }) });
    const second = generateTargetedFootnotes({ targets: ['two'], request: async () => JSON.stringify({ footnotes: [{ anchor: 'two', text: 'Two' }] }) });
    const secondResult = await second;
    release();
    const firstResult = await first;
    assert.deepEqual(secondResult.footnotes.map(f => f.anchor), ['two']);
    assert.equal(firstResult.stale, true);
});

test('targeted result becomes stale after its generation epoch changes', async () => {
    let release;
    const epoch = beginGenerationEpoch();
    const pending = generateTargetedFootnotes({
        targets: ['term'],
        epoch,
        request: () => new Promise(resolve => {
            release = () => resolve(JSON.stringify({ footnotes: [{ anchor: 'term', text: 'Term' }] }));
        }),
    });
    await Promise.resolve();
    bumpGenerationEpoch();
    release();
    const result = await pending;
    assert.equal(result.stale, true);
    assert.deepEqual(result.footnotes, []);
});
