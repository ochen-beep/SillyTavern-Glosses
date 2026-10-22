import test from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import {
    normalizeLoreConfig,
    loreRefKey,
    resolveManualLore,
    collectAutomaticLore,
    LORE_SCAN_MAX_CONTEXT,
} from '../src/lorebooks.js';
import { buildContextBlocks } from '../src/generator.js';

const POST = 'Aurelia opened the astrolabe beside the old observatory.';

function setup(ctxOverrides = {}, settings = {}, loreMeta) {
    resetCtx({
        chat: [
            makeMessage({ mes: 'Earlier line.', name: 'Char' }),
            makeMessage({ mes: POST, name: 'Char' }),
        ],
        chatId: 'lore-test',
        chatMetadata: loreMeta === undefined ? {} : { gls_lorebook: loreMeta },
        extensionSettings: { Glosses: settings },
        ...ctxOverrides,
    });
    loadSettings();
    state.lastActivatedWorldInfo = null;
}

/** Wire a WORLD_INFO_ACTIVATED cache entry for the anchor post (msg 1, swipe 0). */
function armCache(entries) {
    state.lastActivatedWorldInfo = {
        chatId: 'lore-test',
        msgId: '1',
        swipeIdx: 0,
        ts: Date.now(),
        entries,
    };
}

test('normalizeLoreConfig: dedupes entries, sorts, filters to manualBooks', () => {
    const cfg = normalizeLoreConfig({
        enabled: true,
        mode: 'manual',
        manualBooks: ['Beta', 'Alpha'],
        selectedEntries: [
            { book: 'Beta', uid: 2 },
            { book: 'Beta', uid: 2 },          // dup
            { book: 'Beta', uid: '1' },        // string uid coerced
            { book: 'Alpha', uid: 5 },
            { book: 'Orphan', uid: 9 },        // book not in manualBooks → dropped
            { book: '', uid: 3 },              // invalid
        ],
    });
    assert.deepEqual(cfg.selectedEntries, [
        { book: 'Alpha', uid: 5 },
        { book: 'Beta', uid: 1 },
        { book: 'Beta', uid: 2 },
    ]);
    assert.deepEqual(cfg.manualBooks, ['Beta', 'Alpha']);
});

test('loreRefKey: book+uid, whitespace-trimmed', () => {
    assert.equal(loreRefKey({ book: ' A ', uid: 3 }), loreRefKey({ book: 'A', uid: '3' }));
    assert.notEqual(loreRefKey({ book: 'A', uid: 3 }), loreRefKey({ book: 'A', uid: 4 }));
});

test('resolveManualLore: loads picked entries, substitutes params, reports missing', async () => {
    setup({
        loadWorldInfo: async (book) => {
            if (book === 'Alpha') {
                return { entries: { 5: { uid: 5, comment: 'Guild', content: 'The {{user}} guild.', vectorized: false } } };
            }
            throw new Error('book gone');
        },
    });

    const lore = await resolveManualLore(globalThis._stCtx, [
        { book: 'Alpha', uid: 5 },
        { book: 'Gone', uid: 1 },
        { book: 'Alpha', uid: 999 },
    ]);

    assert.equal(lore.text, 'The {{user}} guild.');
    assert.deepEqual(lore.entries, [{ book: 'Alpha', uid: 5, label: 'Guild' }]);
    assert.deepEqual(lore.missing, [
        { book: 'Alpha', uid: 999 },
        { book: 'Gone', uid: 1 },
    ]);
});

test('ATTACHED: cache match → only attached books; global books dropped', async () => {
    setup({
        characters: [{ name: 'Char', data: { extensions: { world: 'CharBook' } } }],
        characterId: 0,
    }, {}, { enabled: true, mode: 'automatic', autoScope: 'attached' });
    armCache([
        { world: 'CharBook', uid: 1, content: 'char lore', vectorized: false },
        { world: 'GlobalBook', uid: 2, content: 'global lore', vectorized: false },
        { uid: 3, content: 'no origin', vectorized: true },   // unusable world → dropped
    ]);

    const lore = await collectAutomaticLore(globalThis._stCtx, {
        chatMessages: [], globalScanData: {}, anchorMsgId: '1', anchorSwipeIdx: 0,
        scope: 'attached',
    });

    assert.equal(lore.text, 'char lore');
    assert.deepEqual(lore.entries, [{ book: 'CharBook', uid: 1, label: 'Entry 1' }]);
});

test('ATTACHED: cache miss → empty, NO fallback scan (getWorldInfoPrompt never runs)', async () => {
    let scanned = false;
    setup({
        getWorldInfoPrompt: () => { scanned = true; return { worldInfoString: 'GLOBAL LEAK' }; },
    }, {}, { enabled: true, mode: 'automatic', autoScope: 'attached' });

    const lore = await collectAutomaticLore(globalThis._stCtx, {
        chatMessages: [], globalScanData: {}, anchorMsgId: '999', anchorSwipeIdx: 0,
        scope: 'attached',
    });

    assert.equal(lore.text, '');
    assert.equal(scanned, false, 'attached scope must never run the global scan');
});

test('ATTACHED: no books bound → empty without touching the cache or scan', async () => {
    let scanned = false;
    setup({
        getWorldInfoPrompt: () => { scanned = true; return { worldInfoString: 'X' }; },
    }, {}, { enabled: true, mode: 'automatic', autoScope: 'attached' });
    armCache([{ world: 'GlobalBook', uid: 1, content: 'global', vectorized: false }]);

    const lore = await collectAutomaticLore(globalThis._stCtx, {
        chatMessages: [], globalScanData: {}, anchorMsgId: '1', anchorSwipeIdx: 0,
        scope: 'attached',
    });

    assert.equal(lore.text, '');
    assert.equal(scanned, false);
});

test('ALL: dry-run scan uses LORE_SCAN_MAX_CONTEXT budget; vectorized from cache only', async () => {
    const calls = [];
    setup({
        getWorldInfoPrompt: (messages, maxContext, isDryRun, scanData) => {
            calls.push({ maxContext, isDryRun });
            return { worldInfoString: 'keyword lore' };
        },
    }, {}, { enabled: true, mode: 'automatic' });
    armCache([
        { world: 'AnyBook', uid: 1, content: 'keyword lore', vectorized: false },  // in scan → must not double
        { world: 'AnyBook', uid: 2, content: 'vector lore', vectorized: true },
    ]);

    const lore = await collectAutomaticLore(globalThis._stCtx, {
        chatMessages: [], globalScanData: {}, anchorMsgId: '1', anchorSwipeIdx: 0,
        scope: undefined, // default = ALL
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxContext, LORE_SCAN_MAX_CONTEXT);
    assert.equal(calls[0].isDryRun, true);
    assert.match(lore.text, /keyword lore/);
    assert.match(lore.text, /vector lore/);
    assert.equal(lore.text.match(/keyword lore/g).length, 1, 'keyword entries must not double');
});

test('generator: per-chat attached + cache miss → WI block absent (no global fallback)', async () => {
    let scanned = false;
    setup({
        getWorldInfoPrompt: () => { scanned = true; return { worldInfoString: 'GLOBAL LEAK' }; },
    }, { includeLorebook: false }, { enabled: true, mode: 'automatic', autoScope: 'attached' });

    const blocks = await buildContextBlocks(1, 0);
    assert.equal(scanned, false);
    assert.ok(!blocks.some(b => b.startsWith('[World info')));
});

test('generator: per-chat manual mode → resolveManualLore text lands in the WI block', async () => {
    setup({
        loadWorldInfo: async () => ({ entries: { 5: { uid: 5, comment: 'Guild', content: 'Manual lore text.' } } }),
    }, {}, { enabled: true, mode: 'manual', manualBooks: ['Alpha'], selectedEntries: [{ book: 'Alpha', uid: 5 }] });

    const blocks = await buildContextBlocks(1, 0);
    const wiBlock = blocks.find(b => b.startsWith('[World info'));
    assert.ok(wiBlock, 'WI block present');
    assert.match(wiBlock, /Manual lore text\./);
});

test('generator: per-chat off + legacy includeLorebook on → full scan at LORE_SCAN_MAX_CONTEXT', async () => {
    const calls = [];
    setup({
        getWorldInfoPrompt: (messages, maxContext, isDryRun, scanData) => {
            calls.push({ maxContext, isDryRun });
            return { worldInfoString: 'Legacy lore.' };
        },
    }, { includeLorebook: true });

    const blocks = await buildContextBlocks(1, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxContext, LORE_SCAN_MAX_CONTEXT);
    const wiBlock = blocks.find(b => b.startsWith('[World info'));
    assert.ok(wiBlock);
    assert.match(wiBlock, /Legacy lore\./);
});

test('generator: per-chat attached + cache match → only attached entries in the block', async () => {
    setup({
        characters: [{ name: 'Char', data: { extensions: { world: 'CharBook' } } }],
        characterId: 0,
        getWorldInfoPrompt: () => ({ worldInfoString: 'GLOBAL LEAK' }),
    }, {}, { enabled: true, mode: 'automatic', autoScope: 'attached' });
    armCache([
        { world: 'CharBook', uid: 1, content: 'attached lore', vectorized: false },
        { world: 'GlobalBook', uid: 2, content: 'global lore', vectorized: false },
    ]);

    const blocks = await buildContextBlocks(1, 0);
    const wiBlock = blocks.find(b => b.startsWith('[World info'));
    assert.ok(wiBlock);
    assert.match(wiBlock, /attached lore/);
    assert.ok(!/GLOBAL LEAK|global lore/.test(wiBlock), 'global lore must not reach the prompt');
});
