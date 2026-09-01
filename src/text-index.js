// @ts-check
/**
 * Glosses — Text index module
 *
 * Single source of truth for "the text of a rendered message": one
 * concatenated string over the DOM's text nodes with an offset map back to
 * (node, local offset) segments. Both anchor VALIDATION (generator) and
 * marker INJECTION (renderer) match against this same model, so an anchor
 * that validates is an anchor that can be physically wrapped — the old
 * asymmetry (flat prompt text vs per-text-node DOM walking) silently lost
 * every anchor that crossed an inline-element or block boundary.
 *
 * Design notes (prior art: hypothes.is fuzzy anchoring, mark.js
 * `acrossElements`, findAndReplaceDOMText, W3C TextQuoteSelector):
 *
 *   - Block/BR boundaries between consecutive text nodes insert a '\n'
 *     separator into the concatenated string. Whitespace normalization then
 *     lets an anchor match across a paragraph/line break exactly like the
 *     old flat-text validation did — but the mapped span yields one segment
 *     per crossed node, so the marker becomes multi-piece instead of
 *     unrenderable.
 *   - Superscript digits injected by a previous marker render (sup.gls-sup)
 *     are excluded from the index; text inside .gls-marker wrappers is
 *     included (the wrapper adds no text), so an index built over a message
 *     that still shows the PREVIOUS generation's highlights equals the index
 *     over the clean DOM. The generator relies on this to validate before
 *     stripping old highlights.
 *   - findFuzzySpan is the second matching tier (LangExtract-style
 *     quote→span grounding): when the exact normalized match misses, a
 *     word-aligned Levenshtein search recovers anchors the model lightly
 *     normalized — Russian inflections («сурьма» → «сурьмой») and markdown
 *     decoration it copied or stripped («*phrase*»). Strictly word-boundary
 *     aligned, per-word and total distance caps, logged by the caller.
 *
 * The pure parts (buildTextModel, segmentsFor, findFuzzySpan,
 * computeContextSelectors) are Node-testable with opaque chunk objects;
 * only buildTextIndex touches the DOM.
 */

import {
    isWordChar,
    normalizeAnchorKey,
    normalizedWithMap,
} from './anchor-utils.js';

// ── Pure model ────────────────────────────────────────────────────────────────

/**
 * Concatenate chunks into one indexed text.
 *
 * @param {Array<{node?: object, text: string, sepBefore?: boolean}>} chunks
 *   Document-order text chunks. `sepBefore: true` inserts a '\n' before the
 *   chunk (block/BR boundary); `node` is opaque (a DOM Text node in
 *   production, anything in tests).
 * @returns {{text: string, boundaries: Array<{node: object, start: number, end: number}>}}
 *   `start`/`end` are offsets into `text` (separators occupy the gaps).
 */
export function buildTextModel(chunks) {
    const parts = [];
    const boundaries = [];
    let cursor = 0;
    for (const chunk of chunks) {
        const text = String(chunk?.text ?? '');
        if (chunk?.sepBefore) { parts.push('\n'); cursor += 1; }
        parts.push(text);
        boundaries.push({ node: chunk?.node ?? null, start: cursor, end: cursor + text.length });
        cursor += text.length;
    }
    return { text: parts.join(''), boundaries };
}

/**
 * Map a concatenated-string span onto per-node segments, clipping to the
 * span and skipping separator gaps.
 *
 * @returns {Array<{node: object, start: number, end: number}>} local offsets
 *   into each node's own text, document order.
 */
export function segmentsFor(model, start, end) {
    const segments = [];
    for (const b of model.boundaries) {
        if (b.end <= start) continue;
        if (b.start >= end) break; // boundaries are sorted by start
        const lo = Math.max(start, b.start) - b.start;
        const hi = Math.min(end, b.end) - b.start;
        if (hi > lo) segments.push({ node: b.node, start: lo, end: hi });
    }
    return segments;
}

/**
 * Context selectors around a resolved span (W3C TextQuoteSelector style,
 * hypothes.is radius). Stored with the footnote so later re-injections can
 * prefer the occurrence the anchor was originally placed on when the anchor
 * string occurs multiple times.
 */
export function computeContextSelectors(text, start, end, radius = 32) {
    const source = String(text ?? '');
    const prefix = source.slice(Math.max(0, start - radius), start).trim();
    const suffix = source.slice(end, Math.min(source.length, end + radius)).trim();
    return { prefix, suffix };
}

// ── Fuzzy tier ────────────────────────────────────────────────────────────────

/** Word-run positions in a space-normalized string. */
function tokenizeWords(str) {
    const words = [];
    let i = 0;
    while (i < str.length) {
        while (i < str.length && str[i] === ' ') i++;
        if (i >= str.length) break;
        const start = i;
        while (i < str.length && str[i] !== ' ') i++;
        words.push({ start, end: i });
    }
    return words;
}

/** Levenshtein distance with an early exit once it exceeds `cap`. */
function levenshtein(a, b, cap) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > cap) return cap + 1;
        prev = cur;
    }
    return prev[b.length];
}

/**
 * Word-aligned fuzzy search of `anchor` in `text`. Returns the best
 * whole-word source span ({text, start, end, distance}) or null. Every
 * needle word maps onto one consecutive source word; words ≤ 4 chars must
 * match exactly, longer words tolerate ≤ 34% edit distance, and the total
 * distance is capped at `maxRatio` of the anchor (min 2, so a single
 * inflection suffix survives).
 */
export function findFuzzySpan(text, anchor, { maxRatio = 0.25, maxWords = 12 } = {}) {
    const needle = normalizeAnchorKey(anchor);
    if (needle.length < 4) return null;
    const needleWords = tokenizeWords(needle);
    if (!needleWords.length || needleWords.length > maxWords) return null;
    const totalCap = Math.max(2, Math.floor(needle.length * maxRatio));

    const mapped = normalizedWithMap(text);
    const sourceWords = tokenizeWords(mapped.normalized);
    let best = null;
    for (let p = 0; p + needleWords.length <= sourceWords.length; p++) {
        let total = 0;
        let ok = true;
        for (let i = 0; i < needleWords.length; i++) {
            const a = needle.slice(needleWords[i].start, needleWords[i].end);
            const b = mapped.normalized.slice(sourceWords[p + i].start, sourceWords[p + i].end);
            if (a === b) continue;
            const wordCap = a.length <= 4 ? 0 : Math.max(1, Math.round(a.length * 0.34));
            const wordBudget = Math.min(wordCap, totalCap - total);
            const d = levenshtein(a, b, wordBudget);
            if (d > wordBudget) { ok = false; break; }
            total += d;
        }
        if (!ok || total > totalCap) continue;
        const nStart = sourceWords[p].start;
        const nEnd = sourceWords[p + needleWords.length - 1].end;
        const first = mapped.map[nStart];
        const last = mapped.map[nEnd - 1];
        if (!first || !last) continue;
        const start = first.start;
        const end = last.end;
        if (isWordChar(mapped.source[start - 1]) || isWordChar(mapped.source[end])) continue;
        if (!best || total < best.distance) {
            best = { text: mapped.source.slice(start, end), start, end, distance: total };
        }
    }
    return best;
}

// ── DOM model ─────────────────────────────────────────────────────────────────

// Tags that break inline flow between adjacent text nodes.
const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

function breaksInlineFlow(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.tagName === 'BR' || BLOCK_TAGS.has(node.tagName);
}

/**
 * True when text nodes a and b (document order) are inline-adjacent: no BR
 * or block element sits between them. Same-parent siblings and crossings
 * through inline elements (<em>, <strong>, <code>, <a>…) are adjacent;
 * paragraph/list-item/table-cell boundaries are not.
 */
function inlineAdjacent(a, b) {
    let common = null;
    for (let p = a; p; p = p.parentNode) {
        if (p.contains?.(b)) { common = p; break; }
    }
    if (!common) return false;
    // Climb a to its child-of-common, rejecting flow-breaking next-siblings.
    let n = a;
    while (n.parentNode && n.parentNode !== common) {
        for (let s = n.nextSibling; s; s = s.nextSibling) {
            if (breaksInlineFlow(s)) return false;
        }
        n = n.parentNode;
    }
    // Climb b to its child-of-common, rejecting flow-breaking previous-siblings.
    let m = b;
    while (m.parentNode && m.parentNode !== common) {
        for (let s = m.previousSibling; s; s = s.previousSibling) {
            if (breaksInlineFlow(s)) return false;
        }
        m = m.parentNode;
    }
    if (n === m) return true; // same parent (or same node) — inline by definition
    // Between the two child-of-common branches every intervening node must
    // keep flow, and neither branch root itself may be a block.
    for (let s = n.nextSibling; s && s !== m; s = s.nextSibling) {
        if (breaksInlineFlow(s)) return false;
    }
    return !breaksInlineFlow(n) && !breaksInlineFlow(m);
}

/**
 * Build the text index over a rendered message's .mes_text (or any element).
 * Excludes superscript digits from a previous marker render (sup.gls-sup);
 * includes text inside .gls-marker wrappers (they add no text of their own).
 * Throws only if the DOM API is unavailable — callers fall back to the flat
 * prompt text (Node tests, detached elements).
 */
export function buildTextIndex(rootEl) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let p = node.parentElement;
            while (p && p !== rootEl) {
                if (p.classList?.contains('gls-sup')) return NodeFilter.FILTER_REJECT;
                p = p.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const chunks = [];
    let node = null;
    let prev = null;
    while ((node = walker.nextNode())) {
        chunks.push({
            node,
            text: node.nodeValue ?? '',
            sepBefore: prev ? !inlineAdjacent(prev, node) : false,
        });
        prev = node;
    }
    return buildTextModel(chunks);
}
