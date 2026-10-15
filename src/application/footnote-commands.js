// @ts-check
/**
 * Glosses — Footnote application commands (pure data layer)
 *
 * editFootnote / deleteFootnote are the single source of truth for mutating a
 * variant's footnote payload. They are PURE with respect to the DOM and
 * toastr: they take a typed command object, re-validate the live variant
 * context, mutate the footnotes, persist through the payload store (coalesced
 * saveChat), and return a typed result. DOM refresh (removeHighlights /
 * injectHighlights) is the PRESENTER's job — the caller reads result.footnotes
 * and re-renders. This keeps the layer free of renderer.js and therefore free
 * of the renderer↔footnote-actions import cycle.
 *
 * Both Edit and Delete enforce the SAME exact-context contract: the message
 * must still show the captured swipeIdx, the variant's current digest must
 * equal the digest captured when the UI was rendered, the caller's predicate
 * must hold, and the footnote must still resolve in the payload.
 *
 * Deps: core (getCtx, extractPlainText, isEpochCurrent),
 * cache (mutateFootnotes, digestFor), parser. No DOM, no renderer, no toastr.
 */

import {
    getCtx, extractPlainText, isEpochCurrent,
} from '../core.js';
import { mutateFootnotes, digestFor } from '../cache.js';
import { indexToSuperscript, normalizeFootnotes } from '../parser.js';
import { reindexTargeted } from '../domain/footnote-payload.js';

/**
 * Resolve which footnote in a footnotes array the command targets.
 *
 * Identity is, in priority order:
 *   1. footnoteId — the footnote's `.index` field (stable within a payload for
 *      the lifetime of a render; survives the {...f} spreads the renumberer
 *      performs on delete).
 *   2. fn — the footnote object reference (legacy; payloads have no durable
 *      per-footnote id).
 *
 * Returns the array index, or -1 when the footnote is no longer in the payload
 * (orphaned — e.g. it was rebound under us).
 *
 * @param {Array} footnotes
 * @param {any} [fn]
 * @param {number} [footnoteId]
 * @returns {number}
 */
function resolveFootnoteIndex(footnotes, fn, footnoteId) {
    if (!Array.isArray(footnotes)) return -1;
    if (footnoteId != null) {
        const idx = footnotes.findIndex(f => f.index === footnoteId);
        if (idx >= 0) return idx;
    }
    if (fn != null) return footnotes.indexOf(fn);
    return -1;
}

/**
 * Renumber a footnotes array 1..N, rewriting each body's leading superscript
 * index. Shared by deleteFootnote and the pool-manager's per-anchor delete so
 * both surfaces renumber identically.
 *
 * @param {Array} footnotes
 * @returns {Array}
 */
export function renumberFootnotes(footnotes) {
    return (Array.isArray(footnotes) ? footnotes : []).map((f, i) => {
        const newIndex = i + 1;
        const sup = indexToSuperscript(newIndex);
        return { ...f, index: newIndex, text: String(f.text || '').replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹\d]+/u, sup) };
    });
}

/**
 * Re-derive the live variant identity for a message and decide whether the
 * command's snapshot still matches it. Returns { stale, footnotes, message }.
 */
function resolveLiveContext(msgId, swipeIdx, digest) {
    const ctx = getCtx();
    const message = ctx.chat?.[parseInt(msgId)];
    if (!message) return { stale: true, footnotes: null, message: null };
    const currentSwipe = message.swipe_id ?? 0;
    const currentDigest = digestFor(msgId, currentSwipe);
    return {
        // stale = the shown variant moved, or its text changed since the UI
        // snapshot (digest mismatch — covers edits AND continue growth).
        stale: currentSwipe !== swipeIdx || currentDigest !== digest,
        currentDigest,
        message,
    };
}

/**
 * Edit one entry's text in place. `kind` selects the array: 'fn' (default)
 * edits a regular footnote (body re-normalized with a fresh numeric prefix),
 * 't' edits a targeted entry (text stored prefix-free, indexes stay
 * positional).
 *
 * @param {{
 *   msgId: string,
 *   swipeIdx: number,
 *   digest: string,
 *   fn?: any,
 *   footnoteId?: number,
 *   kind?: 'fn' | 't',
 *   text: string,
 *   editEpoch?: unknown,
 *   validateContext?: () => boolean,
 * }} command
 * @returns {{ ok: true, footnotes: any[], targeted: any[], message: any, msgId: string }
 *         | { ok: false, reason: 'empty' | 'stale' | 'not-found' | 'persistence-error' }}
 */
export function editFootnote(command) {
    const { msgId, swipeIdx, digest, fn, footnoteId, kind, text, editEpoch, validateContext } = command;
    const trimmed = (text ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };

    const { stale, currentDigest, message } = resolveLiveContext(msgId, swipeIdx, digest);
    if (!message) return { ok: false, reason: 'not-found' };
    if (stale) return { ok: false, reason: 'stale' };

    const isTargeted = kind === 't';
    const source = Array.isArray(message.swipes)
        ? (message.swipes[swipeIdx] ?? message.mes)
        : message.mes;
    try {
        // Persist through the payload store (coalesced saveChat writer). The
        // mutator replaces the entry's text in the selected array; regular
        // footnotes re-normalize order/indices against the live swipe body,
        // targeted entries keep positional order (indexes only).
        const result = mutateFootnotes(msgId, swipeIdx, currentDigest, (entries) => {
            const itemIndex = resolveFootnoteIndex(entries, fn, footnoteId);
            const epochOk = editEpoch == null || isEpochCurrent(editEpoch);
            const contextOk = validateContext ? validateContext() : true;
            if (!epochOk || !contextOk || itemIndex < 0) return null;
            const updated = entries.map((item, index) =>
                index === itemIndex ? { ...item, text: trimmed } : item);
            if (isTargeted) return reindexTargeted(updated);
            return normalizeFootnotes(updated, extractPlainText(source)) || updated;
        }, { kind });
        if (!result.ok) return { ok: false, reason: result.reason === 'not-found' ? 'not-found' : 'stale' };
        return { ok: true, footnotes: result.footnotes, targeted: result.targeted, message, msgId };
    } catch {
        return { ok: false, reason: 'persistence-error' };
    }
}

/**
 * Delete one entry, renumber/reindex survivors, and clear the variant only if
 * BOTH arrays become empty. Enforces the same exact-context contract as
 * editFootnote.
 *
 * @param {{
 *   msgId: string,
 *   swipeIdx: number,
 *   digest: string,
 *   fn?: any,
 *   footnoteId?: number,
 *   kind?: 'fn' | 't',
 *   validateContext?: () => boolean,
 * }} command
 * @returns {{ ok: true, footnotes: any[], targeted: any[], msgId: string, emptied: boolean }
 *         | { ok: false, reason: 'stale' | 'not-found' | 'persistence-error' }}
 */
export function deleteFootnote(command) {
    const { msgId, swipeIdx, digest, fn, footnoteId, kind, validateContext } = command;
    const isTargeted = kind === 't';

    const { stale, currentDigest, message } = resolveLiveContext(msgId, swipeIdx, digest);
    if (!message) return { ok: false, reason: 'not-found' };
    if (stale) return { ok: false, reason: 'stale' };

    try {
        const result = mutateFootnotes(msgId, swipeIdx, currentDigest, (entries) => {
            const itemIndex = resolveFootnoteIndex(entries, fn, footnoteId);
            const contextOk = validateContext ? validateContext() : true;
            if (!contextOk || itemIndex < 0) return null;
            const remaining = entries.filter((_f, i) => i !== itemIndex);
            return isTargeted ? reindexTargeted(remaining) : renumberFootnotes(remaining);
        }, { kind });
        if (!result.ok) return { ok: false, reason: result.reason === 'not-found' ? 'not-found' : 'stale' };
        return { ok: true, footnotes: result.footnotes, targeted: result.targeted, msgId, emptied: result.emptied };
    } catch {
        return { ok: false, reason: 'persistence-error' };
    }
}
