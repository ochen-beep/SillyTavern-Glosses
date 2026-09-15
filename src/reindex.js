// @ts-check
/**
 * Glosses — Reindex module (pure, no browser/ST dependencies).
 *
 * Identity-based remap of cached footnotes after MESSAGE_DELETED. ST sends only
 * newLength (chat.length) WITHOUT the deleted index, so the naive "delete
 * entries with msgId === messageId" approach corrupts the cache: deleting a
 * message in the middle of the chat shifts all subsequent message indices by -1,
 * which silently re-binds those footnotes to the WRONG messages.
 *
 * Instead we match each cached entry to a current AI message by content
 * fingerprint (the first 120 NFC-normalized chars of the swipe text — same
 * heuristic as cache.js getFingerprint) and rewrite entry.msgId to the new
 * index. Entries whose text no longer appears in the chat (the deleted message,
 * or a bulk-truncate) are dropped.
 *
 * Ported from DS Comments/reindex.js, adapted to Glosses' store shape:
 *   Glosses:   { entries: { fp: { footnotes, msgId, swipeIdx, timestamp, fp? } } }
 *   DS Comments: { posts:  { msgId: { swipeIdx: { html, fp, ... } } } }
 *
 * ST-context purity is intentional: tested in Node (`node --test`) without
 * DOM/eventSource.
 */

/**
 * The fingerprint heuristic — first 120 NFC-normalized chars. MUST stay in sync
 * with cache.js getFingerprint so identity matching agrees with the cache key.
 * Duplicated here (not imported) to keep this module free of ST/DOM deps.
 */
function fingerprintPrefix(text) {
    return String(text ?? '').normalize('NFC').slice(0, 120);
}

function isAiMsg(msg, includeUser = false) {
    if (!msg || msg.is_system) return false;
    // User messages count as anchor targets only when glossUserMessages is on
    // (passed through from the events.js caller, which has access to S()).
    return includeUser ? true : !msg.is_user;
}

/**
 * All fingerprint prefixes of a message: mes + all swipes. Deduped via Set so a
 * swipe whose text equals mes doesn't double-count.
 */
function messageFingerprints(msg) {
    const out = new Set();
    if (!msg) return out;
    const consider = (s) => {
        // Any non-empty string: cache.js getFingerprint rejects short posts at
        // WRITE time, but a legacy entry could exist for a short post — and
        // identity matching must still work for it (DS Comments matches any
        // non-empty text).
        if (typeof s === 'string' && s.trim().length > 0) out.add(fingerprintPrefix(s));
    };
    consider(msg.mes);
    if (Array.isArray(msg.swipes)) for (const s of msg.swipes) consider(s);
    return out;
}

/**
 * Identity-based remap of cached footnote entries after a message deletion.
 *
 * @param {Record<string, {msgId: string, swipeIdx?: number, fp?: string} & Record<string, any>>} entries
 *   store.entries: { fp_key: { footnotes, msgId, swipeIdx, timestamp, fp? } }
 * @param {Array} chat current message array (post-deletion); chat.length === newLength
 * @param {number} newLength new chat length (value from MESSAGE_DELETED payload)
 * @param {{ includeUser?: boolean }} [opts] includeUser=true also matches user
 *   messages (for the glossUserMessages setting). Default false keeps the
 *   pre-existing AI-only behaviour.
 * @returns {{ entries: typeof entries, oldToNew: Record<string, string> }}
 *   oldToNew maps old msgId -> new msgId for surviving entries (dropped ones omitted)
 */
export function reindexEntriesAfterDeletion(entries, chat, newLength, { includeUser = false } = {}) {
    const oldEntryList = Object.entries(entries);   // [[fp, entry], ...]
    if (!oldEntryList.length) return { entries: {}, oldToNew: {} };

    const limit = Math.min(newLength, chat.length);

    // fp -> sorted candidate indices in the current chat (AI messages, or AI+user
    // when includeUser is set). User messages can host cached footnotes only when
    // glossUserMessages is on; without this flag their entries would be dropped
    // on any neighbouring deletion.
    const fpToIndices = new Map();
    for (let i = 0; i < limit; i++) {
        const msg = chat[i];
        if (!isAiMsg(msg, includeUser)) continue;
        for (const fp of messageFingerprints(msg)) {
            let arr = fpToIndices.get(fp);
            if (!arr) { arr = []; fpToIndices.set(fp, arr); }
            if (arr[arr.length - 1] !== i) arr.push(i);
        }
    }

    const oldToNew = {};     // oldMsgId → newMsgId (String → String)
    const used = new Set();  // occupied newIndices (bijection per fingerprint)

    for (const [fpKey, entry] of oldEntryList) {
        // Prefer the entry's explicit fp field if present (future-proofing);
        // otherwise the fp IS the key (current Glosses convention).
        const fp = (typeof entry.fp === 'string' && entry.fp) ? entry.fp : fpKey;
        const oldId = parseInt(entry.msgId);
        if (isNaN(oldId)) continue;   // malformed entry, leave as-is

        const candidates = fpToIndices.get(fp);
        if (!candidates || candidates.length === 0) {
            // The message this footnote anchored is gone → drop the entry.
            continue;
        }
        // Closest free candidate to the old index (preserves ordering).
        let best = null, bestDist = Infinity;
        for (const idx of [...candidates].sort((a, b) => a - b)) {
            // Bijection is scoped by (fpKey) — two different cache keys can map
            // to the same message only if they have different fp prefixes that
            // happen to co-occur in one message (different swipes). Allow that.
            const useKey = `${fpKey}:${idx}`;
            if (used.has(useKey)) continue;
            const d = Math.abs(idx - oldId);
            if (d < bestDist) { bestDist = d; best = idx; }
        }
        if (best === null) continue;   // all candidates taken → drop
        used.add(`${fpKey}:${best}`);
        oldToNew[String(oldId)] = String(best);
    }

    // Build the new entries map: copy surviving entries with updated msgId.
    // The fp KEY is unchanged (the swipe text didn't change, only its index);
    // only the entry.msgId field is rewritten to the new position.
    //
    // Stage-4 §4.3 contract: stable entry/footnote IDs survive the remap. The
    // `...entry` spread carries forward entryId/contentDigest (content-addressed
    // and independent of message index), and the per-footnote `index`/anchor
    // fields are untouched — only the host's msgId moves. The stage-5 repository
    // will re-key entriesById by entryId and rely on this stability.
    const newEntries = {};
    for (const [fpKey, entry] of oldEntryList) {
        const oldId = String(entry.msgId);
        const newId = oldToNew[oldId];
        if (newId === undefined) continue;   // dropped
        newEntries[fpKey] = { ...entry, msgId: newId, fp: fpKey };
    }
    return { entries: newEntries, oldToNew };
}
