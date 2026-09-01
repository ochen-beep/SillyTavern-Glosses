// @ts-check
/**
 * Glosses — Metadata repository (chat-scoped lists + legacy store hygiene)
 *
 * Since the per-variant footnote store moved into the message objects
 * (swipe_info[i].extra.gls — see domain/footnote-payload.js), chatMetadata
 * owns only the two chat-scoped exclusion lists:
 *
 *   gls_data.forcedIgnore  — exact phrases never to footnote again
 *   gls_data.poolExcluded  — anchors hidden from the advisory "already
 *                            explained" pool
 *
 * It also exposes wipeLegacyStore() so Clear/Clean can drop the pre-v3.2
 * fingerprint-keyed `entries` map left in old chats (it is never read; this
 * only reclaims the space).
 *
 * All persistence goes through the injected metadata writer (serialized +
 * coalesced saveMetadata) — list mutations coalesce into one host save per
 * tick, and a chat switch never persists the old chat through the new
 * context.
 */

import { getCtx, META_KEY } from '../core.js';
import { normalizeAnchorKey } from '../anchor-utils.js';

function normalizeList(values) {
    const normalized = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const display = String(value ?? '').trim();
        const key = normalizeAnchorKey(display);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        normalized.push(display);
    }
    return normalized;
}

/**
 * @param {{ writer: { schedule: () => void } }} deps
 */
export function createMetadataRepository({ writer }) {
    /**
     * Return the per-chat lists store, creating an empty one if missing or
     * structurally invalid. Always re-reads ctx.chatMetadata (never caches the
     * reference — ST swaps it on chat switch). Read-only: normalization of a
     * legacy store is applied in place but only persisted when it changed.
     */
    function getStore() {
        const ctx = getCtx();
        if (!ctx.chatMetadata) return null;
        const existing = ctx.chatMetadata[META_KEY];
        if (!existing || typeof existing !== 'object') {
            ctx.chatMetadata[META_KEY] = {
                schemaVersion: 3, forcedIgnore: [], poolExcluded: [], targetedDraft: '',
            };
        } else {
            let changed = false;
            for (const field of ['forcedIgnore', 'poolExcluded']) {
                const normalized = normalizeList(existing[field]);
                if (!Array.isArray(existing[field])
                    || normalized.length !== existing[field].length
                    || normalized.some((value, index) => value !== existing[field][index])) {
                    existing[field] = normalized;
                    changed = true;
                }
            }
            if (typeof existing.targetedDraft !== 'string') { existing.targetedDraft = ''; changed = true; }
            if (existing.schemaVersion == null) { existing.schemaVersion = 3; changed = true; }
            if (changed) writer.schedule();
        }
        return ctx.chatMetadata[META_KEY];
    }

    /** Drop the legacy fingerprint-keyed entries map (never read; space reclaim). */
    function wipeLegacyStore() {
        const store = getCtx().chatMetadata?.[META_KEY];
        if (!store || typeof store !== 'object' || !('entries' in store)) return false;
        delete store.entries;
        writer.schedule();
        return true;
    }

    // ── forcedIgnore / poolExcluded ──

    function getForcedIgnore() {
        return [...(getStore()?.forcedIgnore || [])];
    }

    function saveForcedIgnore(values) {
        const store = getStore();
        if (!store) return [];
        store.forcedIgnore = normalizeList(values);
        writer.schedule();
        return [...store.forcedIgnore];
    }

    function getPoolExcluded() {
        return [...(getStore()?.poolExcluded || [])];
    }

    function savePoolExcluded(values) {
        const store = getStore();
        if (!store) return [];
        store.poolExcluded = normalizeList(values);
        writer.schedule();
        return [...store.poolExcluded];
    }

    function togglePoolExcluded(anchor, add) {
        const current = getPoolExcluded();
        const key = normalizeAnchorKey(anchor);
        const exists = current.some(v => normalizeAnchorKey(v) === key);
        if (add && !exists) current.push(String(anchor).trim());
        else if (!add && exists) {
            const idx = current.findIndex(v => normalizeAnchorKey(v) === key);
            if (idx >= 0) current.splice(idx, 1);
        }
        return savePoolExcluded(current);
    }

    function clearPoolExcluded() {
        const store = getStore();
        if (!store || !Array.isArray(store.poolExcluded) || !store.poolExcluded.length) return false;
        store.poolExcluded = [];
        writer.schedule();
        return true;
    }

    // ── targeted draft («Точечно» textarea, per-chat) ──

    /** Hard cap so a pasted novel can't bloat every metadata save. */
    const DRAFT_CAP = 4000;

    function getTargetedDraft() {
        const store = getStore();
        return typeof store?.targetedDraft === 'string' ? store.targetedDraft : '';
    }

    function saveTargetedDraft(value) {
        const store = getStore();
        if (!store) return '';
        const next = String(value ?? '').slice(0, DRAFT_CAP);
        if (store.targetedDraft === next) return next;
        store.targetedDraft = next;
        writer.schedule();
        return next;
    }

    return {
        getStore,
        wipeLegacyStore,
        getForcedIgnore,
        saveForcedIgnore,
        getPoolExcluded,
        savePoolExcluded,
        togglePoolExcluded,
        clearPoolExcluded,
        getTargetedDraft,
        saveTargetedDraft,
    };
}
