// @ts-check
/**
 * Glosses — Rebind engine (anchors ↔ edited text)
 *
 * When a variant's text changes (MESSAGE_UPDATED after an edit, or a
 * "continue" that grew the post), the footnotes are not discarded — each
 * anchor is re-resolved against the new text and only the ones that no longer
 * resolve become orphans. This is the hypothes.is / W3C TextQuoteSelector
 * model the renderer already cites: exact normalized match first, occurrence
 * ranked by the stored prefix/suffix context selectors, fuzzy word-aligned
 * Levenshtein rescue last.
 *
 * Pure module: takes a footnotes array and the new text, returns survivors
 * (renumbered 1..N, context selectors refreshed) plus orphans. No DOM, no
 * SillyTavern context, no persistence — the caller files the result through
 * the payload store.
 */

import { findAllAnchorSpans, normalizeAnchorKey } from '../anchor-utils.js';
import { computeContextSelectors, findFuzzySpan } from '../text-index.js';
import { normalizeFootnotes } from '../parser.js';
import { reindexTargeted } from './footnote-payload.js';

/**
 * Rank an anchor's occurrences by the footnote's stored context selectors
 * (W3C TextQuoteSelector style, computed at save time). Occurrences whose
 * surrounding text matches the stored prefix/suffix sort first, so a
 * re-injection after an edit lands on the occurrence the anchor was
 * originally placed on instead of jumping to the first match. Falls back to
 * document order when nothing matches (heavily edited text).
 *
 * Pure sibling of the renderer's wrap-time ranking — the renderer passes the
 * DOM text index's concatenated string as `text`, the rebind passes the raw
 * variant text.
 *
 * @param {Array<{start: number, end: number}>} occurrences
 * @param {{ prefix?: string, suffix?: string }} fn
 * @param {string} text
 * @param {number} [radius]
 */
export function rankOccurrencesByContext(occurrences, fn, text, radius = 32) {
    if (!occurrences.length || (!fn.prefix && !fn.suffix)) return occurrences;
    const pKey = fn.prefix ? normalizeAnchorKey(fn.prefix) : null;
    const sKey = fn.suffix ? normalizeAnchorKey(fn.suffix) : null;
    const source = String(text ?? '');
    const scored = occurrences.map(span => {
        let score = 0;
        if (pKey) {
            const pre = normalizeAnchorKey(source.slice(Math.max(0, span.start - radius), span.start).trim());
            if (pre && (pre.endsWith(pKey) || pKey.endsWith(pre))) score++;
        }
        if (sKey) {
            const suf = normalizeAnchorKey(source.slice(span.end, Math.min(source.length, span.end + radius)).trim());
            if (suf && (suf.startsWith(sKey) || sKey.startsWith(suf))) score++;
        }
        return { span, score };
    });
    scored.sort((a, b) => b.score - a.score); // stable: document order wins ties
    return scored.map(x => x.span);
}

/**
 * Re-resolve every footnote's anchor against a new text.
 *
 * Tiers per anchor: exact normalized match (occurrences ranked by stored
 * prefix/suffix) → fuzzy word-aligned rescue (the anchor is REWRITTEN to the
 * resolved text so the renderer can place a marker). Per footnote the
 * best-ranked occurrence that does not overlap an already-claimed span wins;
 * footnotes with no free occurrence become orphans.
 *
 * Survivors are renumbered 1..N in document order (normalizeFootnotes) and
 * their prefix/suffix selectors are recomputed for the new text.
 *
 * @param {Array<{index:number, anchor:string, text:string, prefix?:string, suffix?:string}>} footnotes
 * @param {string} newText
 * @returns {{
 *   footnotes: Array<object>,
 *   orphans: Array<{index:number, anchor:string}>,
 *   fuzzyRescues: Array<{from:string, to:string, distance:number}>,
 * }}
 */
export function rebindFootnotes(footnotes, newText) {
    const text = String(newText ?? '');
    const claimed = []; // spans already claimed by an earlier footnote
    const spansOverlap = (a, b) => a.start < b.end && b.start < a.end;

    const survivors = [];
    const orphans = [];
    const fuzzyRescues = [];

    for (const fn of Array.isArray(footnotes) ? footnotes : []) {
        const anchor = String(fn?.anchor ?? '');
        if (!normalizeAnchorKey(anchor)) {
            // No anchor string (legacy text-only payloads) — cannot rebind.
            orphans.push({ index: fn?.index, anchor });
            continue;
        }
        let occurrences = findAllAnchorSpans(text, anchor);
        let fuzzyHit = null;
        if (!occurrences.length) {
            fuzzyHit = findFuzzySpan(text, anchor);
            if (fuzzyHit) occurrences = [fuzzyHit];
        }
        if (!occurrences.length) {
            orphans.push({ index: fn?.index, anchor });
            continue;
        }
        const ranked = rankOccurrencesByContext(occurrences, fn, text);
        const chosen = ranked.find(span => !claimed.some(c => spansOverlap(c, span)));
        if (!chosen) {
            orphans.push({ index: fn?.index, anchor });
            continue;
        }
        claimed.push(chosen);
        const out = { ...fn };
        if (fuzzyHit && chosen === fuzzyHit) {
            out.anchor = fuzzyHit.text;
            fuzzyRescues.push({ from: anchor, to: fuzzyHit.text, distance: fuzzyHit.distance });
        }
        Object.assign(out, computeContextSelectors(text, chosen.start, chosen.end));
        survivors.push(out);
    }

    const normalized = normalizeFootnotes(survivors, text) ?? [];
    return { footnotes: normalized, orphans, fuzzyRescues };
}

/**
 * Re-resolve targeted entries against a new text. Same tiers as
 * rebindFootnotes (exact → fuzzy), with one targeted-specific rule:
 *
 *   - a FLOATING entry (no prefix/suffix selectors — born without an anchor
 *     match) stays in the list even when it still does not resolve; if its
 *     phrase has appeared in the edited text it ANCHORS (selectors filled in);
 *   - an ANCHORED entry that no longer resolves becomes an orphan tagged
 *     `kind:'t'` (merged separately from regular orphans by the caller).
 *
 * Survivors keep their positional order (no document-order re-sort — the
 * symbol marker is derived from position, and re-ordering would silently
 * re-label every entry below the edit point); indexes are re-derived 1..M.
 *
 * @param {Array<{index:number, anchor:string, text:string, prefix?:string, suffix?:string}>} targeted
 * @param {string} newText
 * @returns {{
 *   targeted: Array<object>,
 *   orphans: Array<{index:number, anchor:string, kind:'t'}>,
 *   fuzzyRescues: Array<{from:string, to:string, distance:number}>,
 * }}
 */
export function rebindTargeted(targeted, newText) {
    const text = String(newText ?? '');
    const claimed = [];
    const spansOverlap = (a, b) => a.start < b.end && b.start < a.end;

    const survivors = [];
    const orphans = [];
    const fuzzyRescues = [];

    for (const entry of Array.isArray(targeted) ? targeted : []) {
        const anchor = String(entry?.anchor ?? '');
        const wasAnchored = Boolean(entry?.prefix || entry?.suffix);
        if (!normalizeAnchorKey(anchor)) {
            // No anchor string at all — nothing to resolve; keep as floating.
            survivors.push({ ...entry });
            continue;
        }
        let occurrences = findAllAnchorSpans(text, anchor);
        let fuzzyHit = null;
        if (!occurrences.length) {
            fuzzyHit = findFuzzySpan(text, anchor);
            if (fuzzyHit) occurrences = [fuzzyHit];
        }
        if (!occurrences.length) {
            if (wasAnchored) orphans.push({ index: entry?.index, anchor, kind: 't' });
            else survivors.push({ ...entry }); // floating stays floating
            continue;
        }
        const ranked = rankOccurrencesByContext(occurrences, entry, text);
        const chosen = ranked.find(span => !claimed.some(c => spansOverlap(c, span)));
        if (!chosen) {
            if (wasAnchored) orphans.push({ index: entry?.index, anchor, kind: 't' });
            else survivors.push({ ...entry });
            continue;
        }
        claimed.push(chosen);
        const out = { ...entry };
        if (fuzzyHit && chosen === fuzzyHit) {
            out.anchor = fuzzyHit.text;
            fuzzyRescues.push({ from: anchor, to: fuzzyHit.text, distance: fuzzyHit.distance });
        }
        Object.assign(out, computeContextSelectors(text, chosen.start, chosen.end));
        survivors.push(out);
    }

    const reindexed = reindexTargeted(survivors);
    return { targeted: reindexed, orphans, fuzzyRescues };
}
