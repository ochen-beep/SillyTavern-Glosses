import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { makeMessage } from './helpers/stub-runtime.mjs';
import {
    PAYLOAD_KEY, PAYLOAD_SCHEMA,
    variantText, digestForVariant,
    readRawPayload, readVerifiedPayload,
    stampPayload, writePayload, clearPayload,
} from '../src/domain/footnote-payload.js';
import { contentDigest } from '../src/domain/message-identity.js';

const FNS = [{ index: 1, anchor: 'term', text: '¹ term — note' }];

test('variantText mirrors ST selection: swipes[idx] when present, else mes', () => {
    const msg = makeMessage({ swipes: ['alpha body text', 'beta body text'], swipe_id: 1 });
    assert.equal(variantText(msg, 0), 'alpha body text');
    assert.equal(variantText(msg, 1), 'beta body text');
    const plain = makeMessage({ mes: 'plain body', noSwipeInfo: true });
    assert.equal(variantText(plain, 0), 'plain body');
    assert.equal(variantText(null, 0), '');
});

test('digestForVariant is the full-text content digest of the variant', () => {
    const msg = makeMessage({ swipes: ['one two three', 'one two three four'] });
    assert.equal(digestForVariant(msg, 0), contentDigest('one two three'));
    assert.notEqual(digestForVariant(msg, 0), digestForVariant(msg, 1));
});

test('stampPayload refuses non-viable text (placeholder / short)', () => {
    const placeholder = makeMessage({ mes: '...' });
    assert.equal(stampPayload(placeholder, 0, FNS), null);
    const short = makeMessage({ mes: 'tiny' });
    assert.equal(stampPayload(short, 0, FNS), null);
    const ok = makeMessage({ mes: 'a viable long enough body' });
    const payload = stampPayload(ok, 0, FNS, { style: 'pratchett50' });
    assert.equal(payload.schema, PAYLOAD_SCHEMA);
    assert.equal(payload.contentDigest, contentDigest('a viable long enough body'));
    assert.equal(payload.style, 'pratchett50');
    assert.deepEqual(payload.footnotes, FNS);
    assert.deepEqual(payload.orphans, []);
});

test('writePayload files the slot always and the live mirror only for the shown variant', () => {
    const msg = makeMessage({ swipes: ['first variant body', 'second variant body'], swipe_id: 0 });
    const payload = stampPayload(msg, 1, FNS);
    // Writing variant 1 while variant 0 is shown: slot gets it, live extra must NOT.
    writePayload(msg, 1, payload);
    assert.equal(msg.swipe_info[1].extra[PAYLOAD_KEY], payload);
    assert.equal(msg.extra[PAYLOAD_KEY], undefined);
    // Writing the shown variant mirrors into live extra.
    const p0 = stampPayload(msg, 0, FNS);
    writePayload(msg, 0, p0);
    assert.equal(msg.swipe_info[0].extra[PAYLOAD_KEY], p0);
    assert.equal(msg.extra[PAYLOAD_KEY], p0);
});

test('writePayload works without swipe machinery (user message, live extra only)', () => {
    const msg = makeMessage({ mes: 'a user message long enough', is_user: true, noSwipeInfo: true });
    const payload = stampPayload(msg, 0, FNS);
    writePayload(msg, 0, payload);
    assert.equal(msg.extra[PAYLOAD_KEY], payload);
    assert.equal(readRawPayload(msg, 0), payload);
});

test('readVerifiedPayload gates on digest: inherited extra clone is inert', () => {
    // ST clones the live extra into a NEW swipe slot at generation end. If the
    // old variant's payload leaks into the new variant's slot this way, the
    // digest gate must read it as "no footnotes".
    const msg = makeMessage({ swipes: ['first variant body', 'second variant body'], swipe_id: 1 });
    const stale = stampPayload(msg, 0, FNS);          // digest of variant 0
    msg.swipe_info[1].extra[PAYLOAD_KEY] = stale;     // inherited clone into slot 1
    msg.extra[PAYLOAD_KEY] = stale;                   // and the live mirror
    assert.equal(readRawPayload(msg, 1), stale);      // raw read finds it…
    assert.equal(readVerifiedPayload(msg, 1), null);  // …verified read rejects it
});

test('readVerifiedPayload rejects non-viable text and missing/malformed payloads', () => {
    const msg = makeMessage({ mes: 'a viable body for the note' });
    assert.equal(readVerifiedPayload(msg, 0), null);  // nothing stored
    const payload = stampPayload(msg, 0, FNS);
    writePayload(msg, 0, payload);
    assert.equal(readVerifiedPayload(msg, 0), payload);
    // Text swapped for a placeholder: verified read goes dark, raw survives.
    msg.swipes[0] = '...';
    assert.equal(readVerifiedPayload(msg, 0), null);
    assert.equal(readRawPayload(msg, 0), payload);
    // Malformed shapes never parse as payloads.
    msg.swipes[0] = 'a viable body for the note';
    msg.swipe_info[0].extra[PAYLOAD_KEY] = { footnotes: [] }; // no schema/digest
    assert.equal(readRawPayload(msg, 0), null);
});

test('readRawPayload prefers the slot over the live mirror', () => {
    const msg = makeMessage({ swipes: ['first variant body', 'second variant body'], swipe_id: 0 });
    const p0 = stampPayload(msg, 0, FNS);
    writePayload(msg, 0, p0);
    const foreign = { schema: PAYLOAD_SCHEMA, contentDigest: 'deadbeef', footnotes: [] };
    msg.extra[PAYLOAD_KEY] = foreign; // hypothetical divergence: slot must win
    assert.equal(readRawPayload(msg, 0), p0);
});

test('clearPayload removes the slot and the matching live mirror', () => {
    const msg = makeMessage({ swipes: ['first variant body', 'second variant body'], swipe_id: 0 });
    writePayload(msg, 0, stampPayload(msg, 0, FNS));
    writePayload(msg, 1, stampPayload(msg, 1, FNS));
    assert.equal(clearPayload(msg, 0), true);
    assert.equal(msg.swipe_info[0].extra[PAYLOAD_KEY], undefined);
    assert.equal(msg.extra[PAYLOAD_KEY], undefined);           // mirror matched variant 0
    assert.ok(msg.swipe_info[1].extra[PAYLOAD_KEY]);           // other variant untouched
    assert.equal(clearPayload(msg, 0), false);                 // second clear: nothing left
});

test('payload survives a variant round-trip the way ST swaps extras', () => {
    // Simulate syncMesToSwipe (snapshot live→slot) + syncSwipeToMes (slot→live).
    const msg = makeMessage({ swipes: ['first variant body', 'second variant body'], swipe_id: 0 });
    writePayload(msg, 0, stampPayload(msg, 0, FNS));
    // Swipe away: ST snapshots live extra into the old slot (already in sync).
    msg.swipe_info[0].extra = structuredClone(msg.extra);
    msg.swipe_id = 1;
    // Swipe in: ST replaces live extra with a clone of slot 1's info.
    msg.extra = structuredClone(msg.swipe_info[1].extra ?? {});
    assert.equal(readVerifiedPayload(msg, msg.swipe_id), null); // shown variant (1) has no payload
    msg.swipe_id = 0;
    msg.extra = structuredClone(msg.swipe_info[0].extra ?? {});
    assert.ok(readVerifiedPayload(msg, msg.swipe_id));          // round-trip restores it
});
