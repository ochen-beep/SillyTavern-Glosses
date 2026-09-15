// @ts-check
/**
 * Glosses — reindex unit tests (pure, runnable via `node --test`).
 *
 * Covers identity-based remapping of cached footnotes when MESSAGE_DELETED fires.
 * ST sends only newLength (chat.length) without the deleted index, so remapping
 * uses content fingerprint (entry.fp -> current chat message text), not position.
 *
 * Adapted from DS Comments/test/reindex.test.mjs to Glosses' store shape:
 *   entries: { fp: { footnotes, msgId, swipeIdx, timestamp, fp } }
 * (in Glosses the cache KEY is the fingerprint; msgId lives inside the entry).
 *
 * Scenarios:
 *   A — deleting a mid-chat user message (old heuristic lost the slid AI post)
 *   B — deleting a mid-chat AI message (its cache should drop exactly)
 *   C — deleting the last user message (next AI post slides down)
 *   D — bulk-truncate via ST delete-messages dialog (tail is cut, no shift)
 *   E — entries without fp field (key IS the fp — identity still works)
 *   F — mixed cache: modern fp entry remaps, no-fp entry keeps its slot if alive
 *   G — collision of identical AI posts (bijection: nearest-to-old-index wins)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reindexEntriesAfterDeletion } from '../src/reindex.js';

// ── fixtures ──
function ai(text, opts = {}) {
    const swipes = opts.swipes ?? [text];
    return { is_user: false, is_system: false, is_hidden: false, mes: text, swipes, swipe_id: 0 };
}
function u(text) {
    return { is_user: true, is_system: false, mes: text, swipes: [text], swipe_id: 0 };
}

/** Fingerprint heuristic — MUST match cache.js getFingerprint's prefix rule. */
function fpKey(text) {
    return String(text).normalize('NFC').slice(0, 120);
}

/** A cache entry in Glosses form: key = fp, msgId inside. */
function entry(text, msgId) {
    return {
        footnotes: [{ index: 1, anchor: 'x', text: `fn-of-${text}` }],
        msgId: String(msgId),
        swipeIdx: 0,
        timestamp: Date.now(),
        fp: fpKey(text),
    };
}

const msgIds = entries => Object.values(entries).map(e => parseInt(e.msgId)).sort((a, b) => a - b);
const find = (entries, text) => Object.values(entries).find(e => e.fp === fpKey(text));

// ── Scenario A: deleting a mid-chat user message (old heuristic lost the slid AI post) ──
//   chat6: [U0,A1,U2,A3,U4,A5], cache {1,3,5}
//   delete user idx2  → splice(2,1) → [U0,A1,A3→2,U4→3,A5→4]
//   expected {1,2,4}  (old heuristic wrongly gave {1,4}, losing A3)
test('A: deleting a mid user message remaps slid AI posts', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.splice(2, 1);
    const newLength = chat.length; // 5

    const entries = {
        [fpKey('A1')]: entry('A1', 1),
        [fpKey('A3')]: entry('A3', 3),
        [fpKey('A5')]: entry('A5', 5),
    };

    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [1, 2, 4], `expected {1,2,4}, got {${msgIds(ne)}}`);
    assert.equal(find(ne, 'A3').msgId, '2', 'A3 footnotes should slide to idx 2');
    assert.equal(find(ne, 'A5').msgId, '4', 'A5 footnotes should slide to idx 4');
    assert.equal(oldToNew['3'], '2');
    assert.equal(oldToNew['5'], '4');
});

// ── Scenario B — deleting a mid AI message (its cache drops exactly, rest slides) ──
test('B: deleting a mid AI message drops exactly its cache, slides the rest', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.splice(3, 1);
    const newLength = chat.length;

    const entries = {
        [fpKey('A1')]: entry('A1', 1),
        [fpKey('A3')]: entry('A3', 3),
        [fpKey('A5')]: entry('A5', 5),
    };

    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [1, 4], `expected {1,4}, got {${msgIds(ne)}}`);
    assert.equal(find(ne, 'A1').msgId, '1');
    assert.equal(find(ne, 'A5').msgId, '4');
    assert.equal(oldToNew['3'], undefined, 'deleted A3 must not remap');
    assert.equal(oldToNew['5'], '4');
});

// ── Scenario C — deleting the last user message (trailing AI post slides down) ──
//   delete user idx4 → [U0,A1,U2,A3,A5→4]
//   expected {1,3,4}; old heuristic lost A5.
test('C: deleting the last user message keeps the trailing AI post cache', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.splice(4, 1);
    const newLength = chat.length;

    const entries = {
        [fpKey('A1')]: entry('A1', 1),
        [fpKey('A3')]: entry('A3', 3),
        [fpKey('A5')]: entry('A5', 5),
    };

    const { entries: ne } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [1, 3, 4], `expected {1,3,4}, got {${msgIds(ne)}}`);
    assert.equal(find(ne, 'A5').msgId, '4');
});

// ── Scenario D — bulk-truncate (delete-messages dialog: chat.length = this_del_mes) ──
//   truncate from idx3 → chat3 = [U0,A1,U2]; keys 3 and 5 lose their posts.
test('D: bulk-truncate drops posts beyond cutoff, keeps lower', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.length = 3; // [U0,A1,U2]
    const newLength = 3;

    const entries = {
        [fpKey('A1')]: entry('A1', 1),
        [fpKey('A3')]: entry('A3', 3),
        [fpKey('A5')]: entry('A5', 5),
    };

    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [1], `expected {1}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['1'], '1');
    assert.equal(oldToNew['3'], undefined);
    assert.equal(oldToNew['5'], undefined);
});

// ── Scenario E — entries WITHOUT the fp field: the cache key IS the fp ──
//   Glosses stores fp as the key, so even a legacy entry lacking the inner fp
//   field is identity-matchable via its key. No positional heuristic needed.
test('E: entries without fp field still identity-match via their key', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.splice(2, 1); // delete user idx2 → [U0,A1,A3→2,U4→3,A5→4]
    const newLength = chat.length;

    const entries = {
        [fpKey('A1')]: { footnotes: [{ index: 1, anchor: 'a', text: 't' }], msgId: '1', swipeIdx: 0, timestamp: 0 },
        [fpKey('A3')]: { footnotes: [{ index: 1, anchor: 'a', text: 't' }], msgId: '3', swipeIdx: 0, timestamp: 0 },
        [fpKey('A5')]: { footnotes: [{ index: 1, anchor: 'a', text: 't' }], msgId: '5', swipeIdx: 0, timestamp: 0 },
    };

    const { entries: ne } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [1, 2, 4], `expected {1,2,4}, got {${msgIds(ne)}}`);
});

// ── Scenario F — mixed cache: one entry with fp field, one without ──
test('F: mixed cache — fp entry remaps, no-fp entry keeps its slot if alive', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3'), u('U4'), ai('A5')];
    chat.splice(2, 1); // delete user idx2 → [U0,A1,A3→2,U4→3,A5→4]
    const newLength = chat.length;

    const entries = {
        [fpKey('A1')]: { footnotes: [{ index: 1, anchor: 'a', text: 'legacy' }], msgId: '1', swipeIdx: 0, timestamp: 0 },
        [fpKey('A3')]: entry('A3', 3),
        [fpKey('A5')]: entry('A5', 5),
    };

    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne).sort((a, b) => a - b), [1, 2, 4], `expected {1,2,4}, got {${msgIds(ne)}}`);
    assert.equal(find(ne, 'A3').msgId, '2');
    assert.equal(find(ne, 'A5').msgId, '4');
    assert.equal(oldToNew['1'], '1', 'no-fp entry kept its own slot');
    assert.equal(oldToNew['3'], '2');
    assert.equal(oldToNew['5'], '4');
});

test('F2: no-fp entry DROPPED when its slot no longer holds a live AI post', () => {
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3')];
    chat.splice(1, 1); // delete AI idx1 → [U0,U2,A3→2]
    const newLength = chat.length;

    const entries = {
        [fpKey('A1')]: { footnotes: [{ index: 1, anchor: 'a', text: 'legacy' }], msgId: '1', swipeIdx: 0, timestamp: 0 },
        [fpKey('A3')]: entry('A3', 3),
    };

    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [2], `expected {2}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['1'], undefined, 'no-fp entry dropped (slot is now user msg)');
    assert.equal(oldToNew['3'], '2');
});

// ── Scenario G — collision of identical AI posts ──
//   Two identical AI messages ("DUP") in the chat: each cached entry claims the
//   nearest free candidate, bijection preserved.
test('G: collision — identical posts each claim the nearest free slot', () => {
    const chat = [u('U0'), ai('DUP'), u('U2'), ai('DUP')];
    const entries = {
        [fpKey('DUP')]: entry('DUP', 1),
        // second identical post shares the SAME fp key — only one cache entry
        // can exist per fingerprint (Glosses keys by fp). The single entry
        // claims the nearest candidate (its own index 1).
    };
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, chat.length);
    assert.deepEqual(msgIds(ne), [1], `expected {1}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['1'], '1');
});

test('G2: collision after deletion — nearest-to-old-index wins', () => {
    // chat5: [U0, DUP@1, U2, DUP@3, U4]; delete U2 → [U0, DUP→1, DUP→2, U4→3]
    // The cached entry was written for the post at idx3; candidates are {1,2},
    // nearest to 3 is 2.
    const chat = [u('U0'), ai('DUP'), u('U2'), ai('DUP'), u('U4')];
    chat.splice(2, 1);
    const newLength = chat.length;

    const entries = {
        [fpKey('DUP')]: entry('DUP', 3),
    };
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne), [2], `expected {2}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['3'], '2');
});

test('G3: entry whose text disappeared from the chat is dropped', () => {
    // The cached post ("GONE") was deleted — no message in the chat carries
    // that text anymore (identity matching finds no candidate → drop).
    const chat = [u('U0'), ai('X'), ai('Y')];
    const entries = {
        [fpKey('GONE')]: entry('GONE', 2),
    };
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, chat.length);
    assert.deepEqual(msgIds(ne), [], `expected {}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['2'], undefined, 'post whose text disappeared must be dropped');
});

test('G4: identical-text posts — a cache entry for a surviving duplicate remaps, not drops', () => {
    // Two identical "DUP" posts at idx1 and idx3; the entry was written for
    // idx3. Candidates {1,3} both survive → nearest to old 3 is 3.
    const chat = [u('U0'), ai('DUP'), u('U2'), ai('DUP')];
    const entries = {
        [fpKey('DUP')]: entry('DUP', 3),
    };
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, chat.length);
    assert.deepEqual(msgIds(ne), [3], `expected {3}, got {${msgIds(ne)}}`);
    assert.equal(oldToNew['3'], '3');
});

// ── edge cases ──

test('empty cache: returns empty, never throws', () => {
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion({}, [u('U0'), ai('A1')], 2);
    assert.deepEqual(ne, {});
    assert.deepEqual(oldToNew, {});
});

test('multi-swipe post: identity matches on any swipe text', () => {
    // Post at idx1 has swipes ['X','X-alt'] — a cache entry for swipe 'X-alt'
    // must still anchor to the same post when it slides.
    const chat = [u('U0'), ai('X', { swipes: ['X', 'X-alt'] }), u('U2'), ai('Y')];
    const entries = {
        [fpKey('X-alt')]: entry('X-alt', 1),
        [fpKey('Y')]: entry('Y', 3),
    };
    chat.splice(2, 1); // delete user idx2 → [U0, X→1, Y→2]
    const newLength = chat.length;
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.deepEqual(msgIds(ne).sort((a, b) => a - b), [1, 2], `expected {1,2}, got {${msgIds(ne)}}`);
    assert.equal(find(ne, 'X-alt').msgId, '1', 'swipe-text entry kept its post');
    assert.equal(oldToNew['3'], '2');
});

// ── glossUserMessages support (includeUser option) ──
// Cached footnotes on a {{user}} post must survive a neighbouring deletion only
// when the caller opts in. Default behaviour (no option) keeps the AI-only rule.

test('includeUser=false (default): user-post cache entry is dropped on delete', () => {
    // chat: [U0, A1, U2*, A3] - cache has footnotes for user post U2 (idx2).
    // delete AI A1 (idx1) -> [U0->0, U2->1, A3->2]. Without includeUser, U2 is
    // not a candidate host, so its entry has no match and is dropped.
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3')];
    const entries = {
        [fpKey('U2')]: entry('U2', 2),
        [fpKey('A3')]: entry('A3', 3),
    };
    chat.splice(1, 1); // delete A1
    const newLength = chat.length; // 3
    const { entries: ne } = reindexEntriesAfterDeletion(entries, chat, newLength);
    assert.equal(find(ne, 'U2'), undefined, 'user-post entry dropped without includeUser');
    assert.equal(find(ne, 'A3').msgId, '2', 'AI entry still remaps');
});

test('includeUser=true: user-post cache entry remaps when a neighbour is deleted', () => {
    // Same setup, but the caller opts in via { includeUser: true }. Now U2 is a
    // valid host: its fingerprint matches chat[1] (post-delete), so the entry
    // slides 2->1 instead of being dropped.
    const chat = [u('U0'), ai('A1'), u('U2'), ai('A3')];
    const entries = {
        [fpKey('U2')]: entry('U2', 2),
        [fpKey('A3')]: entry('A3', 3),
    };
    chat.splice(1, 1); // delete A1 -> [U0->0, U2->1, A3->2]
    const newLength = chat.length; // 3
    const { entries: ne, oldToNew } = reindexEntriesAfterDeletion(entries, chat, newLength, { includeUser: true });
    assert.equal(find(ne, 'U2').msgId, '1', 'user-post entry remapped to idx 1');
    assert.equal(find(ne, 'A3').msgId, '2', 'AI entry remapped to idx 2');
    assert.equal(oldToNew['2'], '1', 'U2 old->new mapping recorded');
    assert.equal(oldToNew['3'], '2', 'A3 old->new mapping recorded');
});

test('includeUser=true still drops a user-post entry whose text is gone', () => {
    // Delete the user post itself - its text no longer appears, so even with
    // includeUser the entry must be dropped (not silently re-bound elsewhere).
    const chat = [ai('A0'), u('U1'), ai('A2')];
    const entries = {
        [fpKey('U1')]: entry('U1', 1),
        [fpKey('A2')]: entry('A2', 2),
    };
    chat.splice(1, 1); // delete U1 -> [A0->0, A2->1]
    const newLength = chat.length; // 2
    const { entries: ne } = reindexEntriesAfterDeletion(entries, chat, newLength, { includeUser: true });
    assert.equal(find(ne, 'U1'), undefined, 'deleted user post has no match -> dropped');
    assert.equal(find(ne, 'A2').msgId, '1', 'A2 slides 2->1');
});
