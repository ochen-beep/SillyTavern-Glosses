// @ts-check
/** Pure policy helpers for prior anchors and forced exclusions. */

import { findAnchorInText, normalizeAnchorKey } from './anchor-utils.js';

function numericId(value) {
    const n = Number(value);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/**
 * Permissive "Already explained" pool for the advisory prompt block.
 *
 * Input is the per-variant footnote sets the payload store lists
 * (listFootnoteSets(): {msgId, swipeIdx, footnotes, timestamp} — every
 * verified payload in the chat, any message, any variant). This exists for
 * ONE job: tell the model every anchor Glosses has ever generated for this
 * chat so it can prefer fresh ones.
 *
 * Two filters:
 * 1. exclude anchors from the CURRENT message, so the block can't leak a hint
 *    to re-gloss exactly the message being annotated;
 * 2. exclude anchors whose normalized key is in `excludeKeys` — the per-chat
 *    "hidden from advisory" list the user curates from the pool manager UI.
 *
 * @param {object} opts
 * @param {Array<{msgId: string|number, footnotes: Array, targeted?: Array}>} opts.sets
 *   verified footnote sets across the chat (listFootnoteSets()).
 * @param {number|string} opts.currentMsgId  anchor message id (excluded)
 * @param {number} [opts.limit=200]
 * @param {string[]} [opts.excludeKeys=[]]  normalized keys to hide from the pool
 */
export function collectExplainedAnchors({ sets, currentMsgId, limit = 200, excludeKeys = [] } = {}) {
    if (!Array.isArray(sets)) return [];
    const currentKey = String(currentMsgId);
    const excluded = Array.isArray(excludeKeys) ? new Set(excludeKeys) : null;
    const candidates = [];
    for (const set of sets) {
        if (!set || String(set.msgId) === currentKey) continue;
        const msgId = numericId(set.msgId);
        // Both kinds feed the advisory pool: a targeted gloss explains the
        // phrase just as much as a regular footnote does.
        for (const footnote of [
            ...(Array.isArray(set.footnotes) ? set.footnotes : []),
            ...(Array.isArray(set.targeted) ? set.targeted : []),
        ]) {
            const anchor = String(footnote?.anchor ?? '').trim();
            const normalized = normalizeAnchorKey(anchor);
            if (!normalized) continue;
            if (excluded && excluded.has(normalized)) continue;
            candidates.push({ anchor, normalized, msgId });
        }
    }
    // Newest messages first; sets without a numeric msgId sink to the end
    // but are still kept (they carry valid explained terms).
    candidates.sort((a, b) => {
        if (a.msgId === null && b.msgId === null) return 0;
        if (a.msgId === null) return 1;
        if (b.msgId === null) return -1;
        return b.msgId - a.msgId;
    });
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.normalized)) continue;
        seen.add(candidate.normalized);
        result.push(candidate.anchor);
        if (result.length >= Math.max(0, limit)) break;
    }
    return result;
}

/** Normalize forced-ignore values, preserving first non-empty spelling. */
export function normalizeForcedIgnore(values) {
    const input = Array.isArray(values) ? values : String(values ?? '').split(/\r?\n/u);
    const result = [];
    const seen = new Set();
    for (const value of input) {
        const original = String(value ?? '').trim();
        const key = normalizeAnchorKey(original);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(original);
    }
    return result;
}

/** Combine global stop words and per-chat exclusions by normalized key. */
export function combineForbiddenAnchors(stopWords, forcedIgnore) {
    return normalizeForcedIgnore([...(Array.isArray(stopWords) ? stopWords : []), ...(Array.isArray(forcedIgnore) ? forcedIgnore : [])]);
}
