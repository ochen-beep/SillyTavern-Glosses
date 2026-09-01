// @ts-check
/**
 * Targeted-footnote persistence («Точечно» → payload store) — the contract
 * that targeted entries live in the SAME per-variant payload as regular
 * footnotes, survive sibling writes (regeneration / edit / rebind), reindex
 * positionally, and render through the merged read with kind tags.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import {
    digestFor, getVariantFootnotes, getVariantPayload, saveFootnotes,
    saveTargeted, mutateFootnotes, rebindVariant, listFootnoteSets,
    getTargetedDraft, saveTargetedDraft,
} from '../src/cache.js';
import { indexToTargetedSymbol } from '../src/parser.js';
import { editFootnote, deleteFootnote } from '../src/application/footnote-commands.js';
import { resolveTargetedAnchors, validateTargetedResponse } from '../src/targeted-generation.js';
import { rebindTargeted } from '../src/domain/rebind.js';

const POST = 'Aurelia held the astrolabe beside the old observatory, whispering valar morghulis softly.';

function setupChat() {
    loadSettings();
    resetCtx({ chat: [makeMessage({ mes: POST })] });
}

// ── Symbol sequence ──

test('indexToTargetedSymbol walks the classical sequence then doubles', () => {
    assert.equal(indexToTargetedSymbol(1), '*');
    assert.equal(indexToTargetedSymbol(2), '†');
    assert.equal(indexToTargetedSymbol(3), '‡');
    assert.equal(indexToTargetedSymbol(4), '§');
    assert.equal(indexToTargetedSymbol(5), '‖');
    assert.equal(indexToTargetedSymbol(6), '¶');
    assert.equal(indexToTargetedSymbol(7), '**');
    assert.equal(indexToTargetedSymbol(8), '††');
    assert.equal(indexToTargetedSymbol(13), '***');
    // Defensive clamps.
    assert.equal(indexToTargetedSymbol(0), '*');
    assert.equal(indexToTargetedSymbol('3'), '‡');
});

// ── saveTargeted: upsert, cap, stale guard ──

test('saveTargeted files entries with selectors and reindexes positionally', () => {
    setupChat();
    const digest = digestFor(0, 0);
    const entries = resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe (instr.) — a device.' },
        { anchor: 'valar morghulis', text: 'Valar morghulis (val.) — all men must die.' },
    ], POST);
    const result = saveTargeted(0, 0, entries, { startDigest: digest });
    assert.equal(result.ok, true);
    // Both targets occur in the post → anchored (selectors present).
    assert.equal(result.targeted.length, 2);
    assert.equal(result.targeted[0].index, 1);
    assert.equal(result.targeted[0].anchor, 'astrolabe');
    assert.ok(result.targeted[0].prefix !== undefined && result.targeted[0].suffix !== undefined);
    // Payload persisted in the swipe slot.
    const payload = getVariantPayload(0, 0);
    assert.equal(payload.targeted.length, 2);
    assert.deepEqual(payload.footnotes, []);
});

test('saveTargeted rejects a stale digest and writes nothing', () => {
    setupChat();
    const result = saveTargeted(0, 0, [{ anchor: 'astrolabe', text: 'x' }], { startDigest: 'deadbeef' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
    assert.equal(getVariantPayload(0, 0), null);
});

test('saveTargeted upserts by normalized key and caps at 40', () => {
    setupChat();
    const digest = digestFor(0, 0);
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'first' },
        { anchor: 'unrelated phrase one', text: 'u1' },
    ], POST), { startDigest: digest });
    // Same anchor in a different case → replaces, not appends.
    const result = saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'ASTROLABE', text: 'second' },
    ], POST), { startDigest: digest });
    assert.equal(result.ok, true);
    assert.equal(result.targeted.length, 2);
    assert.equal(result.targeted.find(e => e.anchor.toLowerCase() === 'astrolabe').text, 'second');
    // Cap: 40 entries max.
    const many = Array.from({ length: 50 }, (_, i) => ({ anchor: `cap term ${i}`, text: `t${i}` }));
    const capped = saveTargeted(0, 0, resolveTargetedAnchors(many, ''), { startDigest: digest });
    assert.equal(capped.ok, true);
    assert.equal(capped.targeted.length, 40);
});

test('saveTargeted stores a missing target as floating (no selectors)', () => {
    setupChat();
    const digest = digestFor(0, 0);
    const result = saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'elvish etiquette', text: 'Elvish etiquette (custom) — court manners.' },
    ], POST), { startDigest: digest });
    assert.equal(result.ok, true);
    assert.equal(result.targeted.length, 1);
    assert.equal(result.targeted[0].prefix, undefined);
    assert.equal(result.targeted[0].suffix, undefined);
});

// ── Anti-race: sibling preservation ──

test('regular regeneration preserves targeted siblings and vice versa', () => {
    setupChat();
    const digest = digestFor(0, 0);
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe — a device.' },
    ], POST), { startDigest: digest });

    // A regular generation lands AFTER the targeted save: must not wipe it.
    const ok = saveFootnotes(0, 0, [
        { index: 1, anchor: 'Aurelia', text: '¹ Aurelia (name) — a proper name.' },
    ], { style: 'academic' });
    assert.equal(ok, true);
    let payload = getVariantPayload(0, 0);
    assert.equal(payload.footnotes.length, 1);
    assert.equal(payload.targeted.length, 1);
    assert.equal(payload.style, 'academic');

    // And a later targeted save must not wipe the regular footnotes either.
    const r2 = saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'observatory', text: 'Observatory — a place.' },
    ], POST), { startDigest: digest });
    assert.equal(r2.ok, true);
    payload = getVariantPayload(0, 0);
    assert.equal(payload.footnotes.length, 1);
    assert.equal(payload.targeted.length, 2);
});

test('mutateFootnotes (edit/delete of regular) keeps targeted and empties only when both are empty', () => {
    setupChat();
    const digest = digestFor(0, 0);
    saveFootnotes(0, 0, [{ index: 1, anchor: 'Aurelia', text: '¹ Aurelia — name.' }]);
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe — device.' },
    ], POST), { startDigest: digest });

    // Deleting the LAST regular footnote must NOT clear the payload — the
    // targeted sibling keeps it alive.
    const del = mutateFootnotes(0, 0, digest, (fns) => fns.slice(1));
    assert.equal(del.ok, true);
    assert.equal(del.emptied, false);
    assert.equal(getVariantPayload(0, 0).targeted.length, 1);

    // Deleting the targeted entry too empties the variant entirely.
    const del2 = mutateFootnotes(0, 0, digest, (entries) => entries.slice(1), { kind: 't' });
    assert.equal(del2.ok, true);
    assert.equal(del2.emptied, true);
    assert.equal(getVariantPayload(0, 0), null);
});

// ── Merged read ──

test('getVariantFootnotes returns the merged kind-tagged view', () => {
    setupChat();
    saveFootnotes(0, 0, [{ index: 1, anchor: 'Aurelia', text: '¹ Aurelia — name.' }]);
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe — device.' },
    ], POST), { startDigest: digestFor(0, 0) });
    const merged = getVariantFootnotes(0, 0);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].kind, 'fn');
    assert.equal(merged[1].kind, 't');
    // listFootnoteSets surfaces both arrays too.
    const [set] = listFootnoteSets();
    assert.equal(set.footnotes.length, 1);
    assert.equal(set.targeted.length, 1);
});

// ── Commands with kind ──

test('editFootnote and deleteFootnote operate on the targeted array via kind', () => {
    setupChat();
    saveFootnotes(0, 0, [{ index: 1, anchor: 'Aurelia', text: '¹ Aurelia — name.' }]);
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe — device.' },
        { anchor: 'observatory', text: 'Observatory — place.' },
    ], POST), { startDigest: digestFor(0, 0) });
    const digest = getVariantPayload(0, 0).contentDigest;

    const edited = editFootnote({
        msgId: '0', swipeIdx: 0, digest, kind: 't', footnoteId: 1,
        text: 'Astrolabe (instr.) — an astronomical device.',
    });
    assert.equal(edited.ok, true);
    let payload = getVariantPayload(0, 0);
    assert.equal(payload.targeted[0].text, 'Astrolabe (instr.) — an astronomical device.');
    // Regular footnotes untouched by a targeted edit.
    assert.equal(payload.footnotes.length, 1);

    const deleted = deleteFootnote({
        msgId: '0', swipeIdx: 0, digest, kind: 't', footnoteId: 2,
    });
    assert.equal(deleted.ok, true);
    payload = getVariantPayload(0, 0);
    assert.equal(payload.targeted.length, 1);
    // Positional reindex: the survivor keeps index 1 (symbol * stays stable).
    assert.equal(payload.targeted[0].index, 1);
});

// ── Rebind ──

test('rebindTargeted: anchored entry orphans, floating survives, fuzzy rescues, late anchor fills in', () => {
    const anchored = { index: 1, anchor: 'observatory', text: 'Observatory — place.', prefix: 'the old', suffix: ', whispering' };
    const floating = { index: 2, anchor: 'elvish etiquette', text: 'Elvish etiquette — manners.' };
    const fuzzy = { index: 3, anchor: 'astrolobe', text: 'typo form' };

    const edited = 'She held the astrolabe beside the window, speaking of elvish etiquette at length tonight.';
    const result = rebindTargeted([anchored, floating, fuzzy], edited);

    // 'observatory' is gone with no near neighbour → orphan tagged kind 't'.
    assert.deepEqual(result.orphans, [{ index: 1, anchor: 'observatory', kind: 't' }]);
    // The typo'd anchor fuzzy-rescued and was rewritten to the source form.
    const rescued = result.targeted.find(e => e.text === 'typo form');
    assert.ok(rescued && rescued.anchor === 'astrolabe', 'fuzzy rescue rewrites the anchor');
    assert.ok(result.fuzzyRescues.some(r => r.from === 'astrolobe' && r.to === 'astrolabe'));
    // Floating entry anchored itself once the phrase appeared in the text.
    const floated = result.targeted.find(e => e.anchor === 'elvish etiquette');
    assert.ok(floated && floated.prefix !== undefined, 'floating entry anchors when its phrase appears');
    // Positional indexes re-derived.
    result.targeted.forEach((e, i) => assert.equal(e.index, i + 1));
});

test('rebindVariant preserves targeted through a text edit', () => {
    setupChat();
    saveTargeted(0, 0, resolveTargetedAnchors([
        { anchor: 'astrolabe', text: 'Astrolabe — device.' },
    ], POST), { startDigest: digestFor(0, 0) });

    // Edit the post text (keep the anchor phrase, change the tail).
    const ctx = globalThis._stCtx;
    const newText = POST.replace('whispering', 'murmuring');
    ctx.chat[0].mes = newText;
    ctx.chat[0].swipes[0] = newText;

    const result = rebindVariant(0, 0);
    assert.equal(result.changed, true);
    assert.equal(result.payload.targeted.length, 1);
    assert.equal(result.payload.targeted[0].anchor, 'astrolabe');
    assert.ok(result.payload.targeted[0].prefix !== undefined);
});

// ── Per-chat draft ──

test('targeted draft persists per-chat through chatMetadata', () => {
    setupChat();
    assert.equal(getTargetedDraft(), '');
    saveTargetedDraft('astrolabe\nvalar morghulis');
    assert.equal(getTargetedDraft(), 'astrolabe\nvalar morghulis');
    // Cap at 4000 chars.
    saveTargetedDraft('x'.repeat(5000));
    assert.equal(getTargetedDraft().length, 4000);
    // The store lives in chatMetadata (per-chat by construction).
    assert.equal(globalThis._stCtx.chatMetadata.gls_data.targetedDraft.length, 4000);
});

// ── Model-side validation: prefix-free bodies ──

test('validateTargetedResponse emits prefix-free bodies ready for persistence', () => {
    const result = validateTargetedResponse({ footnotes: [
        { anchor: 'astrolabe', text: '¹ Astrolabe (instr.) — a device.' },
    ] }, ['astrolabe']);
    assert.equal(result.footnotes[0].text, 'Astrolabe (instr.) — a device.');
    const resolved = resolveTargetedAnchors(result.footnotes.map(f => ({ anchor: f.anchor, text: f.text })), POST);
    assert.ok(resolved[0].prefix !== undefined, 'resolved against the post text');
});
