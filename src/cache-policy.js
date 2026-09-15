// @ts-check
/**
 * Glosses — Cache policy helpers (pure, no SillyTavern/DOM deps).
 *
 * Leaf-count LRU pruning and access-time bumping for the footnote cache.
 * Ported from DS Comments/src/cache-policy.js, adapted to Glosses' store shape:
 *
 *   Glosses store.entries: { fp: { footnotes, msgId, swipeIdx, timestamp, fp } }
 *   DS Comments store.posts: { msgId: { swipeIdx: { html, timestamp, fp } } }
 *
 * Glosses' shape is already flat (one leaf per fingerprint), so the "leaf
 * count" here is simply the number of entries.
 */

function normalizeTimestamp(ts) {
    return Number.isFinite(ts) ? ts : -1;
}

/**
 * Prune store.entries to keep at most `maxEntries` leaf entries.
 *
 * @param {object} entries - store.entries shape: { fp: { timestamp, msgId, ... } }.
 * @param {object} options
 * @param {number} options.maxEntries - positive integer capacity.
 * @param {string} options.incoming - fingerprint key being inserted.
 * @param {string} [options.protectedEntry] - fingerprint of the currently-viewed
 *   entry; evicted LAST so LRU never yanks the footnote the user is reading.
 * @returns {object} new entries object (input is not mutated).
 */
export function pruneCacheEntries(entries, { maxEntries, incoming, protectedEntry = null }) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || !Number.isInteger(maxEntries)) {
        throw new RangeError('maxEntries must be a positive integer');
    }

    const incomingKey = String(incoming);
    const protectedKey = protectedEntry ? String(protectedEntry) : null;

    const leaves = [];
    for (const [key, entry] of Object.entries(entries || {})) {
        leaves.push({ key, entry, ts: normalizeTimestamp(entry?.timestamp) });
    }

    const incomingExists = !!entries?.[incomingKey];
    const removeCount = Math.max(0, leaves.length + (incomingExists ? 0 : 1) - maxEntries);

    // Sort unprotected before protected, then by timestamp asc, then stable ordinal.
    const ordered = [...leaves].sort((a, b) => {
        const aProtected = a.key === protectedKey ? 1 : 0;
        const bProtected = b.key === protectedKey ? 1 : 0;
        if (aProtected !== bProtected) return aProtected - bProtected;
        if (a.ts !== b.ts) return a.ts - b.ts;
        return 0;
    });

    const removedKeys = new Set(ordered.slice(0, removeCount).map(l => l.key));

    const result = {};
    for (const leaf of leaves) {
        if (removedKeys.has(leaf.key)) continue;
        result[leaf.key] = leaf.entry;
    }

    // Reserve the incoming slot so the caller can atomically assign the new
    // entry without racing a victim that happens to be the incoming key.
    if (!incomingExists) {
        result[incomingKey] = { footnotes: [], timestamp: Date.now(), fp: incomingKey };
    }

    return result;
}

/**
 * Bump the access timestamp of a single cache entry.
 *
 * Mutates `entry.timestamp` IN PLACE and returns the same `entries` reference —
 * zero allocation on the cache-hit hot path (getCachedFootnotes calls this per
 * panel render). The self-assignment (`store.entries = touchCacheEntry(...)`)
 * is harmless; no caller compares store.entries by identity across this call.
 *
 * @param {object} entries - store.entries.
 * @param {string} fp - fingerprint key of the entry being touched.
 * @param {number} accessedAt
 * @returns {object} the same `entries` reference (mutated in place), or the
 *   original if the entry is missing.
 */
export function touchCacheEntry(entries, fp, accessedAt) {
    const entry = entries?.[String(fp)];
    if (!entry) return entries;
    const old = normalizeTimestamp(entry.timestamp);
    entry.timestamp = Math.max(old + 1, Number.isFinite(accessedAt) ? accessedAt : old + 1);
    return entries;
}
