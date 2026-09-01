// @ts-check
/**
 * Foreign-payload regression tests (inter-swipe anchor transplant bug).
 *
 * Scenario (user report): a swipe whose text shares words/phrases with another
 * swipe of the same message must NOT inherit that other swipe's footnotes.
 * SillyTavern plants the old variant's live extra (including the gls payload)
 * into a freshly created swipe slot via its own cloning (syncMesToSwipe at
 * generation end); the digest gate correctly rejects the clone on the verified
 * read, but the rebind path used to treat any digest mismatch as "my text was
 * edited" and re-stamped the foreign payload with the new variant's digest —
 * permanently adopting the other swipe's anchors wherever words coincided.
 *
 * Covered levels:
 *   - domain: payloadBelongsToOtherVariant + the closed live-mirror leak in
 *     readRawPayload (see also footnote-payload.test.mjs)
 *   - cache: rebindVariant clears foreign payloads instead of repairing them
 *   - events: MESSAGE_SWIPED on a variant holding a foreign clone leaves the
 *     variant with NO footnotes (and reaches auto-generation)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { makeMessage, resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import {
    PAYLOAD_KEY, stampPayload, writePayload,
    readRawPayload, payloadBelongsToOtherVariant,
} from '../src/domain/footnote-payload.js';
import { rebindVariant, readRawPayloadFor, getVariantFootnotes } from '../src/cache.js';
import { bindEvents, unbindEvents } from '../src/events.js';

// Variant texts deliberately share words ("серебряный лес") so an transplanted
// anchor would resolve on the new variant — the exact bug condition.
const TEXT_A = 'Она вошла в серебряный лес, где свет луны ломался о ветви.';
const TEXT_B = 'Серебряный лес кончился; впереди лежала пустошь, поросшая вереском.';
const FNS_A = [{ index: 1, anchor: 'серебряный лес', text: '¹ серебряный лес — note for variant A' }];

/** Message whose swipe 1 slot holds an inherited clone of swipe 0's payload. */
function makeTransplantedMessage() {
    const msg = makeMessage({ swipes: [TEXT_A, TEXT_B], swipe_id: 1 });
    const payload = stampPayload(msg, 0, FNS_A);
    msg.swipe_info[0].extra[PAYLOAD_KEY] = payload;
    // What ST does at generation end: the live extra (payload of variant 0)
    // is cloned into the NEW swipe slot.
    msg.swipe_info[1].extra[PAYLOAD_KEY] = structuredClone(payload);
    msg.extra = structuredClone(msg.swipe_info[1].extra);
    return msg;
}

// ── domain: payloadBelongsToOtherVariant ──

test('payloadBelongsToOtherVariant: inherited clone (digest of swipe 0) is foreign', () => {
    const msg = makeTransplantedMessage();
    assert.equal(payloadBelongsToOtherVariant(msg, 1, msg.swipe_info[1].extra[PAYLOAD_KEY]), true);
});

test('payloadBelongsToOtherVariant: own edited payload is NOT foreign', () => {
    const msg = makeMessage({ swipes: [TEXT_A, TEXT_B], swipe_id: 0 });
    const payload = stampPayload(msg, 0, FNS_A);
    writePayload(msg, 0, payload);
    // The variant's text is now edited in place: digest matches no variant.
    msg.swipes[0] = `${TEXT_A} Продолжение истории.`;
    assert.equal(payloadBelongsToOtherVariant(msg, 0, payload), false);
});

test('payloadBelongsToOtherVariant: no swipe machinery / bad payload → false', () => {
    const plain = makeMessage({ mes: TEXT_A, noSwipeInfo: true });
    const payload = stampPayload(plain, 0, FNS_A);
    assert.equal(payloadBelongsToOtherVariant(plain, 0, payload), false);
    assert.equal(payloadBelongsToOtherVariant(null, 0, payload), false);
    assert.equal(payloadBelongsToOtherVariant(plain, 0, null), false);
});

// ── domain: readRawPayload no longer leaks the live mirror for slotted messages ──

test('readRawPayload ignores a foreign live mirror on a slotted message with an empty slot', () => {
    const msg = makeMessage({ swipes: [TEXT_A, TEXT_B], swipe_id: 0 });
    const foreign = stampPayload(msg, 1, FNS_A); // digest of variant 1
    msg.extra = { [PAYLOAD_KEY]: foreign };      // mirror left from showing variant 1
    assert.equal(readRawPayload(msg, 0), null);   // slot 0 empty → no payload, no leak
    // User-style message without slots keeps the mirror as its only storage.
    const plain = makeMessage({ mes: TEXT_A, is_user: true, noSwipeInfo: true });
    const own = stampPayload(plain, 0, FNS_A);
    plain.extra = { [PAYLOAD_KEY]: own };
    assert.equal(readRawPayload(plain, 0), own);
});

// ── cache: rebindVariant ──

test('rebindVariant clears a foreign payload instead of transplanting anchors', () => {
    const msg = makeTransplantedMessage();
    resetCtx({ chat: [msg] });

    const result = rebindVariant('0', 1);
    assert.equal(result.foreign, true);
    assert.equal(result.payload, null);
    assert.equal(result.changed, true);
    // Slot and live mirror are wiped; the variant reads as never-glossed.
    assert.equal(msg.swipe_info[1].extra[PAYLOAD_KEY], undefined);
    assert.equal(msg.extra[PAYLOAD_KEY], undefined);
    assert.equal(readRawPayloadFor('0', 1), null);
    assert.equal(getVariantFootnotes('0', 1), null);
    // The ORIGINAL variant's payload is untouched.
    assert.ok(msg.swipe_info[0].extra[PAYLOAD_KEY]);
});

test('rebindVariant still repairs an honestly edited own payload (no foreign flag)', () => {
    const msg = makeMessage({ swipes: [TEXT_A], swipe_id: 0 });
    writePayload(msg, 0, stampPayload(msg, 0, FNS_A));
    resetCtx({ chat: [msg] });

    // Continue: the text grows, the shared anchor survives.
    msg.swipes[0] = `${TEXT_A} Тропа вывела её к реке.`;
    const result = rebindVariant('0', 0);
    assert.notEqual(result.foreign, true);
    assert.equal(result.changed, true);
    assert.equal(result.payload.footnotes.length, 1);
    assert.equal(result.payload.footnotes[0].anchor, 'серебряный лес');
    // Re-stamped with the new text's digest → verified read succeeds.
    assert.equal(getVariantFootnotes('0', 0)?.length, 1);
});

// ── events: MESSAGE_SWIPED path ──

test('MESSAGE_SWIPED on a variant holding a foreign clone yields no footnotes', async () => {
    unbindEvents();
    loadSettings();
    // Keep the end of the flow observable without firing a real generation.
    state.settings.enabled = true;
    state.settings.autoGenerate = false;

    const msg = makeTransplantedMessage();
    const handlers = new Map();
    resetCtx({
        chat: [msg],
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED', CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED', MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
        },
        eventSource: {
            on: (ev, fn) => {
                if (!handlers.has(ev)) handlers.set(ev, []);
                handlers.get(ev).push(fn);
            },
            removeListener: () => {},
        },
    });
    bindEvents();

    await handlers.get('MESSAGE_SWIPED')[0]('0');

    // The foreign clone is gone and nothing was transplanted onto the
    // shared "серебряный лес" wording of variant 1.
    assert.equal(msg.swipe_info[1].extra[PAYLOAD_KEY], undefined);
    assert.equal(msg.extra[PAYLOAD_KEY], undefined);
    assert.equal(getVariantFootnotes('0', 1), null);
    assert.equal(readRawPayloadFor('0', 1), null);
});
