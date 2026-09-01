// @ts-check
/**
 * Glosses — Cache module (facade over the per-variant payload store)
 *
 * Footnote data lives INSIDE message objects (swipe_info[i].extra.gls with a
 * live msg.extra mirror — domain/footnote-payload.js), so the variant↔data
 * association is maintained by SillyTavern itself and dies with the variant.
 * This facade resolves messages from the live chat, files payloads through
 * the race-safe write rule, and persists via a coalesced saveChat writer.
 *
 * The chatMetadata store keeps only the chat-scoped exclusion lists
 * (forcedIgnore / poolExcluded) through the slim metadata repository; the
 * legacy fingerprint-keyed entries map is never read and is wiped by
 * clearAll() for space reclamation.
 *
 * API map (vs the pre-v3.2 entry-store facade):
 *   getVariantFootnotes(msgId, swipeIdx)   — digest-verified read (display paths)
 *   readRawPayloadFor(msgId, swipeIdx)     — ungated read (rebind/inspect)
 *   digestFor(msgId, swipeIdx)             — identity of the current variant text
 *   saveFootnotes(msgId, swipeIdx, fns, meta) — generation commit
 *   saveTargeted(msgId, swipeIdx, entries, opts) — targeted commit (upsert)
 *   rebindVariant(msgId, swipeIdx)         — repair a stale payload after an edit
 *   mutateFootnotes(msgId, swipeIdx, digest, mutator) — edit/delete with staleness guard
 *   clearVariant / clearAll / listFootnoteSets / stats
 */

import { getCtx, t, notifyUser } from './core.js';
import { createMetadataWriter } from './infrastructure/metadata-writer.js';
import { createChatWriter } from './infrastructure/chat-writer.js';
import { createMetadataRepository } from './infrastructure/metadata-repository.js';
import {
    readRawPayload, readVerifiedPayload, stampPayload, writePayload, clearPayload,
    variantText, digestForVariant, targetedOf, payloadBelongsToOtherVariant,
} from './domain/footnote-payload.js';
import { isViableMessageText } from './domain/message-identity.js';
import { normalizeAnchorKey } from './anchor-utils.js';
import { rebindFootnotes, rebindTargeted } from './domain/rebind.js';

// Singleton writers + lists repository. All are stateless except for the
// coalescing timers; the chat array is re-read from ctx on every access, so
// the singletons stay correct across chat switches.
//
// Persistence failures were console-only: a failed saveMetadata/saveChat
// silently dropped footnote data until the next successful save. The writers
// already dedupe onError to once per 5 s; notifyUser adds a visible toast
// over the same window so a broken save is at least seen.
function persistenceError(kind) {
    return (err) => {
        console.warn(`[Glosses] Failed to save ${kind}:`, err);
        notifyUser('error', t(`Could not save footnote ${kind}. Glosses retries on the next change.`), `gls-${kind}-save`);
    };
}
const _metadataWriter = createMetadataWriter({
    getContext: () => getCtx(),
    debounceMs: 200,
    onError: persistenceError('metadata'),
});
const _chatWriter = createChatWriter({ onError: persistenceError('chat') });
const _lists = createMetadataRepository({ writer: _metadataWriter });

function msgAt(msgId) {
    return getCtx().chat?.[parseInt(msgId)] ?? null;
}

// ── Read API ──

/**
 * Digest-verified footnotes for a variant, or null. The ONLY display read.
 *
 * Returns the MERGED view — regular footnotes (tagged `kind:'fn'`) followed by
 * targeted entries (tagged `kind:'t'`) — so every injection path renders both
 * kinds. The copies are shallow: `kind` lives only on the read model, never in
 * the persisted payload.
 */
export function getVariantFootnotes(msgId, swipeIdx) {
    const payload = readVerifiedPayload(msgAt(msgId), swipeIdx);
    if (!payload) return null;
    return [
        ...payload.footnotes.map(f => ({ ...f, kind: 'fn' })),
        ...targetedOf(payload).map(e => ({ ...e, kind: 't' })),
    ];
}

/** Digest-verified payload for a variant (footnotes + targeted + orphans), or null. */
export function getVariantPayload(msgId, swipeIdx) {
    return readVerifiedPayload(msgAt(msgId), swipeIdx);
}

/** Ungated payload read — for the rebind path that must find a stale payload. */
export function readRawPayloadFor(msgId, swipeIdx) {
    return readRawPayload(msgAt(msgId), swipeIdx);
}

/** Identity (djb2 hex) of a variant's current text; '' when the message is gone. */
export function digestFor(msgId, swipeIdx) {
    return digestForVariant(msgAt(msgId), swipeIdx);
}

/** True when the variant's text is viable (not a placeholder / too short). */
export function variantIsViable(msgId, swipeIdx) {
    return isViableMessageText(variantText(msgAt(msgId), swipeIdx));
}

/**
 * Every verified payload in the chat (all messages × all variants), newest
 * msgId first. Feeds the advisory pool and the cache stats.
 */
export function listFootnoteSets() {
    const chat = getCtx().chat || [];
    const out = [];
    chat.forEach((msg, i) => {
        if (!msg) return;
        const variants = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        for (let s = 0; s < variants; s++) {
            const payload = readVerifiedPayload(msg, s);
            if (!payload) continue;
            out.push({
                msgId: String(i),
                swipeIdx: s,
                footnotes: payload.footnotes,
                targeted: targetedOf(payload),
                timestamp: Number(payload.generatedAt) || 0,
            });
        }
    });
    return out.sort((a, b) => (Number(b.msgId) || -1) - (Number(a.msgId) || -1));
}

export function stats() {
    const sets = listFootnoteSets();
    return {
        entries: sets.length,
        footnotes: sets.reduce((sum, s) => sum + (s.footnotes?.length || 0) + (s.targeted?.length || 0), 0),
    };
}

// ── Write API ──

/**
 * Commit a freshly generated footnote set for a variant. Stamps the payload
 * with the digest of the CURRENT variant text (callers have already verified
 * the variant did not change mid-flight) and files it race-safely.
 *
 * Anti-race contract: the sibling `targeted` array of the existing payload is
 * re-read and forwarded SYNCHRONOUSLY (no awaits between read and write), so
 * a regular regeneration can never wipe targeted entries saved a moment
 * earlier — and vice versa (saveTargeted forwards footnotes the same way).
 *
 * @returns {boolean} true when the payload was filed and a chat save scheduled.
 */
export function saveFootnotes(msgId, swipeIdx, footnotes, meta = {}) {
    const msg = msgAt(msgId);
    if (!msg || !getCtx().chatId) return false;
    const sibling = readVerifiedPayload(msg, swipeIdx);
    const payload = stampPayload(msg, swipeIdx, footnotes, {
        ...meta,
        targeted: Array.isArray(meta.targeted) ? meta.targeted : targetedOf(sibling),
    });
    if (!payload) return false; // non-viable text — never persist
    writePayload(msg, swipeIdx, payload);
    _chatWriter.schedule();
    return true;
}

/** Cap for the targeted array inside one variant's payload. */
const TARGETED_CAP = 40;

/**
 * Commit targeted footnotes («Точечно» tab) for a variant: upsert by normalized
 * anchor key against the existing entries, capped, then reindexed
 * positionally 1..M (the index is the marker id; the displayed symbol is
 * derived from it at render time).
 *
 * Commit guard mirrors the generator's: the message must still show this
 * swipe and the variant's live digest must equal `startDigest` (captured when
 * the request was launched), else { ok:false, reason:'stale' } and nothing is
 * written. Read-merge-write is fully synchronous — no interleaving window.
 *
 * @param {string} msgId
 * @param {number} swipeIdx
 * @param {Array<{anchor:string, text:string, prefix?:string, suffix?:string}>} entries
 * @param {{ startDigest?: string }} [opts]
 * @returns {{ ok: true, targeted: Array, footnotes: Array }
 *         | { ok: false, reason: 'not-found' | 'stale' }}
 */
export function saveTargeted(msgId, swipeIdx, entries, opts = {}) {
    const msg = msgAt(msgId);
    if (!msg || !getCtx().chatId) return { ok: false, reason: 'not-found' };
    if ((msg.swipe_id ?? 0) !== (Number(swipeIdx) || 0)) return { ok: false, reason: 'stale' };
    const liveDigest = digestForVariant(msg, swipeIdx);
    if (typeof opts.startDigest === 'string' && opts.startDigest && liveDigest !== opts.startDigest) {
        return { ok: false, reason: 'stale' };
    }
    const payload = readVerifiedPayload(msg, swipeIdx);
    const merged = [...targetedOf(payload)];
    const byKey = new Map(merged.map(e => [normalizeAnchorKey(e?.anchor), e]));
    for (const entry of Array.isArray(entries) ? entries : []) {
        const key = normalizeAnchorKey(entry?.anchor);
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) merged[merged.indexOf(existing)] = entry; // replace in place
        else if (merged.length < TARGETED_CAP) { byKey.set(key, entry); merged.push(entry); }
    }
    const targeted = merged.map((e, i) => ({ ...e, index: i + 1 }));
    const stamped = stampPayload(msg, swipeIdx, payload?.footnotes ?? [], {
        style: payload?.style ?? '',
        orphans: payload?.orphans ?? [],
        targeted,
    });
    if (!stamped) return { ok: false, reason: 'stale' }; // non-viable text — never persist
    writePayload(msg, swipeIdx, stamped);
    _chatWriter.schedule();
    return { ok: true, targeted: stamped.targeted, footnotes: stamped.footnotes };
}

/** Merge previous and fresh orphans, deduped by normalized anchor+kind, capped. */
function mergeOrphans(previous, fresh, cap = 40) {
    const merged = [];
    const seen = new Set();
    for (const orphan of [...(fresh ?? []), ...(previous ?? [])]) {
        const anchor = String(orphan?.anchor ?? '');
        const key = `${normalizeAnchorKey(anchor)}\u0000${orphan?.kind === 't' ? 't' : 'fn'}`;
        if (!normalizeAnchorKey(anchor) || seen.has(key)) continue;
        seen.add(key);
        merged.push({ index: orphan?.index ?? 0, anchor, kind: orphan?.kind === 't' ? 't' : 'fn' });
        if (merged.length >= cap) break;
    }
    return merged;
}

/**
 * Repair a variant's stale payload after its text changed (edit / continue).
 * Survivors keep their footnotes (anchors re-resolved, context selectors
 * refreshed); dead anchors become orphans surfaced by the panel. A payload
 * whose digest already matches is returned unchanged (idempotent — the
 * MESSAGE_UPDATED-after-cancel case). Non-viable new text leaves the stale
 * payload untouched for a later retry.
 *
 * A digest-mismatched payload whose digest matches ANOTHER variant of this
 * message is FOREIGN (planted here by SillyTavern's extra cloning when the
 * swipe slot was created, not by an edit of this variant's text): it is
 * cleared and reported as { foreign: true, payload: null } so the caller can
 * treat the variant as never having had footnotes (fresh generation), instead
 * of transplanting the other variant's anchors onto coincidentally matching
 * words.
 *
 * @returns {{ changed: boolean, payload: object|null, nonViable?: boolean, fuzzyRescues?: Array, foreign?: boolean } | null}
 *   null when there is nothing to rebind (no payload / no message).
 */
export function rebindVariant(msgId, swipeIdx) {
    const msg = msgAt(msgId);
    if (!msg) return null;
    const raw = readRawPayload(msg, swipeIdx);
    if (!raw) return null;
    const text = variantText(msg, swipeIdx);
    if (!isViableMessageText(text)) return { changed: false, payload: raw, nonViable: true };
    if (raw.contentDigest === digestForVariant(msg, swipeIdx)) {
        return { changed: false, payload: raw };
    }
    if (payloadBelongsToOtherVariant(msg, swipeIdx, raw)) {
        clearPayload(msg, swipeIdx);
        _chatWriter.schedule();
        return { changed: true, payload: null, foreign: true };
    }
    const { footnotes, orphans, fuzzyRescues } = rebindFootnotes(raw.footnotes, text);
    const targetedResult = rebindTargeted(targetedOf(raw), text);
    orphans.push(...targetedResult.orphans);
    fuzzyRescues.push(...targetedResult.fuzzyRescues);
    const payload = stampPayload(msg, swipeIdx, footnotes, {
        style: raw.style,
        orphans: mergeOrphans(raw.orphans, orphans),
        targeted: targetedResult.targeted,
    });
    if (!payload) return { changed: false, payload: raw, nonViable: true };
    writePayload(msg, swipeIdx, payload);
    _chatWriter.schedule();
    return { changed: true, payload, fuzzyRescues };
}

/**
 * Guarded mutation for edit/delete: re-verify the payload against the current
 * variant text AND the caller's expected digest (captured when the UI was
 * rendered), then replace ONE array (regular footnotes or targeted, per
 * `opts.kind`) through the mutator. The sibling array is forwarded untouched.
 * A payload whose BOTH arrays end up empty clears the variant.
 *
 * @param {string} msgId
 * @param {number} swipeIdx
 * @param {string|null} expectedDigest — null skips the digest check (not recommended).
 * @param {(entries: Array) => Array|null} mutator — returns the next array, or null to abort.
 * @param {{ kind?: 'fn' | 't' }} [opts]
 * @returns {{ ok: true, footnotes: Array, targeted: Array, emptied: boolean } | { ok: false, reason: 'not-found'|'stale' }}
 */
export function mutateFootnotes(msgId, swipeIdx, expectedDigest, mutator, opts = {}) {
    const kind = opts.kind === 't' ? 't' : 'fn';
    const msg = msgAt(msgId);
    if (!msg) return { ok: false, reason: 'not-found' };
    const payload = readVerifiedPayload(msg, swipeIdx);
    if (!payload) return { ok: false, reason: 'stale' };
    if (typeof expectedDigest === 'string' && expectedDigest && payload.contentDigest !== expectedDigest) {
        return { ok: false, reason: 'stale' };
    }
    const pool = kind === 't' ? targetedOf(payload) : payload.footnotes;
    let next;
    try {
        next = mutator(pool);
    } catch {
        return { ok: false, reason: 'stale' };
    }
    if (!Array.isArray(next)) return { ok: false, reason: 'stale' };
    const nextFootnotes = kind === 't' ? payload.footnotes : next;
    const nextTargeted = kind === 't' ? next : targetedOf(payload);
    if (!nextFootnotes.length && !nextTargeted.length) {
        clearPayload(msg, swipeIdx);
        _chatWriter.schedule();
        return { ok: true, footnotes: [], targeted: [], emptied: true };
    }
    const updated = stampPayload(msg, swipeIdx, nextFootnotes, {
        style: payload.style,
        orphans: payload.orphans,
        targeted: nextTargeted,
    });
    writePayload(msg, swipeIdx, updated);
    _chatWriter.schedule();
    return { ok: true, footnotes: updated.footnotes, targeted: updated.targeted, emptied: false };
}

/** Remove the payload from one variant (panel "clear this message"). */
export function clearVariant(msgId, swipeIdx) {
    const msg = msgAt(msgId);
    if (!msg) return false;
    const removed = clearPayload(msg, swipeIdx);
    if (removed) _chatWriter.schedule();
    return removed;
}

/**
 * Remove every footnote payload from the chat (all messages × all variants),
 * optionally the advisory pool exclusions, plus the legacy metadata entries.
 */
export function clearAll(opts = {}) {
    const chat = getCtx().chat || [];
    let removed = false;
    for (const msg of chat) {
        if (!msg) continue;
        if (Array.isArray(msg.swipe_info)) {
            for (const slot of msg.swipe_info) {
                if (slot?.extra && 'gls' in slot.extra) { delete slot.extra.gls; removed = true; }
            }
        }
        if (msg.extra && 'gls' in msg.extra) { delete msg.extra.gls; removed = true; }
    }
    const legacyWiped = _lists.wipeLegacyStore();
    const poolWiped = opts.clearPoolExcluded ? _lists.clearPoolExcluded() : false;
    if (removed) _chatWriter.schedule();
    if (legacyWiped || poolWiped) _metadataWriter.schedule();
    return removed || legacyWiped || poolWiped;
}

// ── chat-scoped exclusion lists (chatMetadata via the repository) ──

export const getForcedIgnore = _lists.getForcedIgnore;
export const saveForcedIgnore = _lists.saveForcedIgnore;
export const getPoolExcluded = _lists.getPoolExcluded;
export const togglePoolExcluded = _lists.togglePoolExcluded;
export const getTargetedDraft = _lists.getTargetedDraft;
export const saveTargetedDraft = _lists.saveTargetedDraft;

/** Expose both writers' flush for page-hide / cleanup (bounded). */
export const flushMetadata = async () => {
    await Promise.all([_metadataWriter.flush(), _chatWriter.flush()]);
};
