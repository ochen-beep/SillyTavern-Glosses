// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Owner decision 2026-11-15 — a regeneration commit must never wipe the user's
// hand-edited footnote texts. editFootnote marks user-written text with
// `edited: true`; saveFootnotes carries edited entries over the fresh model
// output (same anchor → the user's text wins; anchor gone from the post →
// the entry rides along as floating), and saveTargeted's upsert keeps the
// edited text when replacing the same anchor. Entries without the flag behave
// exactly as before. Renumbering rewrites the leading superscript, so body
// assertions strip it.

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { carryEditedFootnotes } from '../src/domain/footnote-payload.js';
import { saveFootnotes, saveTargeted, mutateFootnotes, getVariantPayload, digestFor } from '../src/cache.js';

const POST = 'The keeper unrolled the parchment while the storm carried voices over the courtyard.';
const stripSup = (t) => String(t).replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹]+ /u, '');

test('carry keeps the user text for a surviving anchor and floats a dead one', () => {
    const prev = [
        { index: 1, anchor: 'parchment', text: '¹ parchment — user wrote this.', edited: true },
        { index: 2, anchor: 'storm', text: '² storm — model text.' },
        { index: 3, anchor: 'harbor', text: '³ harbor — user edited, then the phrase left the post.', edited: true },
    ];
    const incoming = [
        { index: 1, anchor: 'parchment', text: '¹ parchment — fresh model wording.' },
        { index: 2, anchor: 'keeper', text: '² keeper — fresh model wording.' },
    ];
    const merged = carryEditedFootnotes(prev, incoming, POST);
    assert.equal(merged.length, 3, 'the dead edited anchor rides along');
    const parchment = merged.find((f) => f.anchor === 'parchment');
    assert.equal(stripSup(parchment.text), 'parchment — user wrote this.', 'the user text wins over fresh wording');
    assert.equal(parchment.edited, true);
    const keeper = merged.find((f) => f.anchor === 'keeper');
    assert.equal(stripSup(keeper.text), 'keeper — fresh model wording.', 'unflagged entries keep the model text');
    const harbor = merged.find((f) => f.anchor === 'harbor');
    assert.equal(harbor.floating, true, 'an edited anchor that died becomes floating');
    assert.equal(stripSup(harbor.text), 'harbor — user edited, then the phrase left the post.');
    assert.equal(harbor.edited, true);
    assert.deepEqual(merged.map((f) => f.index), [1, 2, 3], 'renumbered 1..N');
});

test('carry is a no-op without edited entries', () => {
    const prev = [{ index: 1, anchor: 'parchment', text: '¹ parchment — model.' }];
    const incoming = [{ index: 1, anchor: 'storm', text: '² storm — fresh.' }];
    assert.equal(carryEditedFootnotes(prev, incoming, POST), incoming, 'identity, not a copy');
});

function setup() {
    resetCtx({ chatId: 'test-chat', chat: [null, null, makeMessage({ mes: POST })] });
    loadSettings();
}

test('saveFootnotes carries edited texts across a regeneration commit', () => {
    setup();
    const msgId = 2;
    saveFootnotes(msgId, 0, [
        { index: 1, anchor: 'parchment', text: '¹ parchment — model.' },
        { index: 2, anchor: 'storm', text: '² storm — model.' },
    ], { style: 'hybrid' });
    // editFootnote's mutator effect (the flag contract the carry depends on).
    const digest = digestFor(msgId, 0);
    const editRes = mutateFootnotes(msgId, 0, digest, (entries) =>
        entries.map((item) => item.anchor === 'parchment'
            ? { ...item, text: '¹ parchment — user wrote this.', edited: true }
            : item));
    assert.equal(editRes.ok, true);

    // Regeneration returns fresh wording for the same anchors → the user's
    // parchment text survives; storm keeps the model text.
    saveFootnotes(msgId, 0, [
        { index: 1, anchor: 'parchment', text: '¹ parchment — fresh model wording.' },
        { index: 2, anchor: 'storm', text: '² storm — fresh model wording.' },
    ], { style: 'hybrid' });
    const payload = getVariantPayload(msgId, 0);
    assert.equal(stripSup(payload.footnotes.find((f) => f.anchor === 'parchment').text), 'parchment — user wrote this.');
    assert.equal(stripSup(payload.footnotes.find((f) => f.anchor === 'storm').text), 'storm — fresh model wording.');
});

test('a regen that no longer sees the edited anchor floats the entry instead of dropping it', () => {
    setup();
    const msgId = 2;
    saveFootnotes(msgId, 0, [{ index: 1, anchor: 'harbor', text: '¹ harbor — model.' }], { style: 'hybrid' });
    mutateFootnotes(msgId, 0, digestFor(msgId, 0), (entries) =>
        entries.map((item) => ({ ...item, text: '¹ harbor — user wrote this.', edited: true })));
    // The fresh set anchors something else entirely.
    saveFootnotes(msgId, 0, [{ index: 1, anchor: 'parchment', text: '¹ parchment — fresh model wording.' }], { style: 'hybrid' });
    const payload = getVariantPayload(msgId, 0);
    const harbor = payload.footnotes.find((f) => f.anchor === 'harbor');
    assert.ok(harbor, 'the edited entry survives the regen');
    assert.equal(harbor.floating, true);
    assert.equal(stripSup(harbor.text), 'harbor — user wrote this.');
    assert.equal(payload.footnotes.find((f) => f.anchor === 'parchment').floating, undefined);
});

test('saveTargeted upsert keeps an edited text when replacing the same anchor', () => {
    setup();
    const msgId = 2;
    saveFootnotes(msgId, 0, [], { style: 'hybrid' });
    const d1 = digestFor(msgId, 0);
    const first = saveTargeted(msgId, 0, [{ anchor: 'harbor', text: 'harbor — model note.' }], { startDigest: d1 });
    assert.equal(first.ok, true);
    const editRes = mutateFootnotes(msgId, 0, digestFor(msgId, 0), (entries) =>
        entries.map((item) => ({ ...item, text: 'harbor — user note.', edited: true })), { kind: 't' });
    assert.equal(editRes.ok, true);
    const regen = saveTargeted(msgId, 0, [{ anchor: 'harbor', text: 'harbor — fresh model note.' }], { startDigest: digestFor(msgId, 0) });
    assert.equal(regen.ok, true);
    assert.equal(regen.targeted[0].text, 'harbor — user note.', 'the upsert keeps the user text');
    assert.equal(regen.targeted[0].edited, true);
});
