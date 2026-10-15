// @ts-check
/**
 * Glosses — per-chat lorebook configuration (Phase A).
 *
 * Ported from DS Comments (src/lorebooks.js) with the gls_ naming. The lore
 * config lives PER CHAT in chatMetadata.gls_lorebook — it travels with the
 * chat, unlike the coarse global includeLorebook toggle.
 *
 * Modes:
 *   AUTOMATIC — ride the main generation's WORLD_INFO_ACTIVATED event cache
 *               (bound to the anchor post by events.js):
 *     · scope ALL     — keyword/constant entries via a dry-run
 *                       getWorldInfoPrompt scan, plus vectorized entries from
 *                       the activation cache (the scan text already contains
 *                       the keyword ones; taking the whole cache would double
 *                       them).
 *     · scope ATTACHED— strictly the activated entries whose book is bound to
 *                       this chat (character card book, chat book, persona
 *                       book). Global-panel entries are excluded by design.
 *                       The dry-run scan is NOT used here: its
 *                       worldInfoString is origin-free, so global entries
 *                       could not be separated out.
 *   MANUAL (Phase B) — user-picked books/entries via the picker; the config
 *                       shape (manualBooks/selectedEntries) is already
 *                       normalized and persisted here.
 *
 * Degradation contract: when the activation cache does not match the anchor
 * (regen of an older post, swipes) collectAutomaticLore returns empty text —
 * the GENERATOR decides the fallback (Glosses degrades to the legacy full
 * scan, which DS Comments did not do).
 */

import { getCtx, state } from './core.js';

const LORE_META_KEY = 'gls_lorebook';

export const LORE_MODE = Object.freeze({
    AUTOMATIC: 'automatic',
    MANUAL: 'manual',
});

/**
 * Auto-mode lore scope. ATTACHED restricts automatic lore to the books bound
 * to this chat: the character card book, the chat book and the persona book.
 * Books merely ticked in ST's global World Info panel are excluded there.
 */
export const LORE_SCOPE = Object.freeze({
    ALL: 'all',
    ATTACHED: 'attached',
});

/** @param {unknown} value */
function parseUid(value) {
    if (typeof value !== 'number'
        && (typeof value !== 'string' || value.trim() === '')) {
        return undefined;
    }
    try {
        const uid = Number(value);
        return Number.isFinite(uid) ? uid : undefined;
    } catch {
        return undefined;
    }
}

/** @param {{ book: string, uid: number|string }} ref */
function loreRefKey({ book, uid }) {
    let safeUid = '';
    try {
        safeUid = String(uid);
    } catch {
        // Malformed refs are discarded by normalizeLoreConfig.
    }
    return `${String(book).trim()}\u0000${safeUid}`;
}

/** @param {unknown} value */
function normalizeLoreConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    const mode = source.mode === LORE_MODE.MANUAL
        ? LORE_MODE.MANUAL
        : LORE_MODE.AUTOMATIC;
    const refs = Array.isArray(source.selectedEntries) ? source.selectedEntries : [];
    const selectedEntries = [];
    const seen = new Set();

    for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || typeof ref.book !== 'string') continue;
        const book = ref.book.trim();
        const uid = parseUid(ref.uid);
        if (!book || uid === undefined) continue;

        const normalized = { book, uid };
        const key = loreRefKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        selectedEntries.push(normalized);
    }

    selectedEntries.sort((left, right) => {
        const localeOrder = left.book.localeCompare(right.book);
        if (localeOrder !== 0) return localeOrder;
        if (left.book !== right.book) return left.book < right.book ? -1 : 1;
        return left.uid - right.uid;
    });

    // manualBooks: the books added to the settings panel. Legacy configs have no
    // such list — derive it from their references so nothing is lost.
    const rawBooks = Array.isArray(source.manualBooks) ? source.manualBooks : null;
    const manualBooks = [];
    const seenBooks = new Set();
    for (const name of rawBooks ?? selectedEntries.map(ref => ref.book)) {
        if (typeof name !== 'string') continue;
        const book = name.trim();
        if (!book || seenBooks.has(book)) continue;
        seenBooks.add(book);
        manualBooks.push(book);
    }
    const bookSet = new Set(manualBooks);
    const filteredEntries = selectedEntries.filter(ref => bookSet.has(ref.book));

    // enabled: an explicit flag wins. No object → fresh chat → false (matches
    // the old includeLorebook default).
    const enabled = typeof source.enabled === 'boolean'
        ? source.enabled
        : value !== null && typeof value === 'object';

    // autoScope: undefined (not 'all') is the default, so legacy configs and
    // an explicit 'all' coerce identically through JSON round-trips.
    const autoScope = source.autoScope === LORE_SCOPE.ATTACHED
        ? LORE_SCOPE.ATTACHED
        : undefined;

    return { enabled, mode, manualBooks, selectedEntries: filteredEntries, autoScope };
}

/** @param {ReturnType<typeof getCtx>} [ctx] */
export function getChatLoreConfig(ctx = getCtx()) {
    return normalizeLoreConfig(ctx?.chatMetadata?.[LORE_META_KEY]);
}

/**
 * @param {unknown} config
 * @param {ReturnType<typeof getCtx>} [ctx]
 */
export function saveChatLoreConfig(config, ctx = getCtx()) {
    const normalized = normalizeLoreConfig(config);
    if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
        ctx.chatMetadata = {};
    }
    ctx.chatMetadata[LORE_META_KEY] = normalized;
    // Debounced host save: lore config is not latency-critical, and Glosses'
    // writer flush (flushWriters) covers close-mid-write.
    ctx.saveMetadataDebounced?.();
    return normalized;
}

/**
 * Books bound to the current chat with their binding role, as visible through
 * getContext(). Mirrors the non-global sources of ST's getSortedEntries
 * (world-info.js): the character card book (data.extensions.world), the chat
 * book (chat_metadata.world_info) and the persona book
 * (power_user.persona_description_lorebook). ST deduplicates each source
 * against the others; here the same book may legitimately appear twice when
 * two bindings coincide — consumers deduplicate.
 *
 * Known limitation: character extra books (world_info.charLore) are module
 * state not exposed on the context, so they cannot be listed here.
 *
 * @param {ReturnType<typeof getCtx>} [ctx]
 * @returns {Array<{ role: 'char'|'chat'|'persona', book: string }>}
 */
function resolveAttachedLorebookSources(ctx = getCtx()) {
    const candidates = [
        { role: 'char', book: ctx?.characters?.[ctx?.characterId]?.data?.extensions?.world },
        { role: 'chat', book: ctx?.chatMetadata?.world_info },
        { role: 'persona', book: ctx?.powerUserSettings?.persona_description_lorebook },
    ];
    const sources = [];
    for (const { role, book } of candidates) {
        if (typeof book !== 'string') continue;
        const trimmed = book.trim();
        if (trimmed) sources.push({ role, book: trimmed });
    }
    return sources;
}

/**
 * Distinct names of the books bound to the current chat.
 *
 * @param {ReturnType<typeof getCtx>} [ctx]
 * @returns {Set<string>} trimmed, deduplicated book names; possibly empty
 */
function resolveAttachedLorebooks(ctx = getCtx()) {
    return new Set(resolveAttachedLorebookSources(ctx).map(source => source.book));
}

/**
 * Consumed WORLD_INFO_ACTIVATED cache entries bound to the anchor post, or
 * null when the cache is absent / belongs to another chat or post.
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ anchorMsgId?: string, anchorSwipeIdx?: number }} input
 */
function getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx }) {
    const cached = state.lastActivatedWorldInfo;
    if (!cached
        || cached.chatId !== ctx.chatId
        || cached.msgId === null
        || String(cached.msgId) !== String(anchorMsgId)
        || cached.swipeIdx !== anchorSwipeIdx) {
        return null;
    }
    return cached.entries;
}

/**
 * ATTACHED scope: lore strictly from the WORLD_INFO_ACTIVATED cache, filtered
 * to books bound to this chat. The dry-run getWorldInfoPrompt scan is NOT used
 * here — its worldInfoString is an origin-free blob, so global-panel entries
 * could not be separated out. Consequence: when the cache does not match the
 * anchor (manual regen of an older post, swipes), lore degrades to empty —
 * the GENERATOR falls back to the legacy full scan in that case.
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ anchorMsgId?: string, anchorSwipeIdx?: number }} input
 */
async function collectAttachedLore(ctx, { anchorMsgId, anchorSwipeIdx }) {
    const empty = { text: '', entries: [], missing: [], cacheMatched: false };
    const attached = resolveAttachedLorebooks(ctx);
    if (!attached.size) return empty;

    const entries = getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx });
    if (!entries) return empty;

    // Every activated entry of the matched books is taken — including
    // vectorized ones (no scan runs in this scope, so nothing can double).
    // Entries without a usable `world` are dropped: an activation we cannot
    // attribute to a bound book must not leak into a restricted prompt.
    const contents = [];
    const provenance = [];
    for (const entry of entries) {
        if (typeof entry?.world !== 'string' || !attached.has(entry.world)) continue;
        const uid = parseUid(entry.uid);
        const content = typeof entry.content === 'string' && entry.content.length > 0
            ? (typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(entry.content)
                : entry.content)
            : '';
        if (content) contents.push(content);
        if (uid !== undefined) {
            provenance.push({
                book: entry.world,
                uid,
                label: entry.comment || `Entry ${uid}`,
            });
        }
    }

    return {
        text: contents.join('\n\n'),
        entries: provenance,
        missing: [],
        cacheMatched: true,
    };
}

/**
 * AUTOMATIC ALL scope: keyword/constant entries through the dry-run scan,
 * plus ONLY the vectorized entries from the activation cache (the scan text
 * already contains the keyword/constant ones — taking the whole cache would
 * double them). Pure concat of both sources.
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ chatMessages: unknown[], globalScanData: unknown, anchorMsgId?: string, anchorSwipeIdx?: number }} input
 */
export async function collectAutomaticLore(ctx, { chatMessages, globalScanData, anchorMsgId, anchorSwipeIdx, scope }) {
    if (scope === LORE_SCOPE.ATTACHED) {
        return collectAttachedLore(ctx, { anchorMsgId, anchorSwipeIdx });
    }

    // 1. keyword/constant entries — through ST getWorldInfoPrompt.
    // CONTRACT — isDryRun is ALWAYS true here. A non-dry-run scan re-emits
    // WORLD_INFO_ACTIVATED and writes sticky/cooldown timed-effects into
    // chat_metadata outside ST's generation cycle.
    let scanText = '';
    if (typeof ctx?.getWorldInfoPrompt === 'function') {
        try {
            const result = await ctx.getWorldInfoPrompt(
                chatMessages,
                ctx.maxContext || 4096,
                true,
                globalScanData,
            );
            scanText = typeof result?.worldInfoString === 'string' ? result.worldInfoString : '';
        } catch { /* skip */ }
    }

    // 2. vectorized entries — from the WORLD_INFO_ACTIVATED cache, bound to
    //    the anchor post. Cache miss (regen of an older post) just skips them.
    let activatedText = '';
    const activatedEntries = getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx });
    if (activatedEntries) {
        const contents = activatedEntries
            .filter(e => e.vectorized)
            .map(e => typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(e.content)
                : e.content)
            .filter(c => typeof c === 'string' && c.length > 0);
        activatedText = contents.join('\n\n');
    }

    const text = [scanText, activatedText].filter(Boolean).join('\n\n');
    return { text, entries: [], missing: [], cacheMatched: Boolean(activatedEntries) };
}
