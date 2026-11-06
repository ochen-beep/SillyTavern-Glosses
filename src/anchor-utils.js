// @ts-check
/** Shared exact-normalized anchor matching policy. */

// Quote/dash canonicalization shared by the per-char and per-key normalizers.
// String.replace never persists lastIndex for /g regexes, so module-level
// constants are safe to share.
const _SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B']/gu;
const _DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F«»"]/gu;
const _DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2212-]/gu;
// Typographic ellipsis → three ASCII dots: models routinely re-quote a post's
// … (U+2026) as `...` in anchors, exact matching is byte-normalized, and the
// fuzzy tier cannot rescue long anchors (word cap 12). … U+2026, ⋯ U+22EF.
const _ELLIPSES = /[\u2026\u22EF]/gu;

function normalizeChar(ch) {
    return ch
        .normalize('NFC')
        .replace(_SINGLE_QUOTES, "'")
        .replace(_DOUBLE_QUOTES, '"')
        .replace(_DASHES, '-')
        .replace(_ELLIPSES, '...');
}

export function normalizeAnchorKey(value) {
    return String(value ?? '')
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(_SINGLE_QUOTES, "'")
        .replace(_DOUBLE_QUOTES, '"')
        .replace(_DASHES, '-')
        .replace(_ELLIPSES, '...')
        .replace(/\s+/gu, ' ');
}

export function isWordChar(ch) {
    if (!ch) return false;
    try { return /[\p{L}\p{N}_]/u.test(ch); }
    catch { return /[A-Za-z0-9_А-Яа-яЁё]/u.test(ch); }
}

// P1: the grapheme Segmenter is expensive to construct and is stateless —
// one per module suffices (previously built per call, once per anchor
// attempt; with the 100-footnote cap that was ~100 constructions per inject).
let _segmenter;
function _graphemePieces(source) {
    if (_segmenter === undefined) {
        try { _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); }
        catch { _segmenter = null; }   // older engine — code-unit fallback
    }
    if (_segmenter) {
        const pieces = [];
        for (const part of _segmenter.segment(source)) pieces.push({ text: part.segment, start: part.index, end: part.index + part.segment.length });
        return pieces;
    }
    const pieces = [];
    for (let i = 0; i < source.length; i++) pieces.push({ text: source[i], start: i, end: i + 1 });
    return pieces;
}

// P1: the map for a given source text is pure and immutable after build, and
// marker injection re-normalizes the SAME post once per anchor (up to 100
// with the current cap) — a small LRU kills the per-anchor rebuild. Keys are
// source strings (interned references, never copied); 8 posts cover an
// active chat view amply.
const _MAP_CACHE_MAX = 8;
const _mapCache = new Map();

function _buildNormalizedMap(source) {
    const pieces = _graphemePieces(source);
    const units = [];
    let pendingSpace = null;
    for (const part of pieces) {
        const normalized = normalizeChar(part.text).toLowerCase();
        if (/^\s+$/u.test(normalized)) {
            if (units.length && !pendingSpace) pendingSpace = part;
            continue;
        }
        if (pendingSpace) {
            units.push({ ch: ' ', start: pendingSpace.start, end: pendingSpace.end });
            pendingSpace = null;
        }
        for (const ch of normalized) units.push({ ch, start: part.start, end: part.end });
    }
    // String.indexOf speaks UTF-16 code units while `map` is indexed per
    // normalized code point (an astral char like an emoji is one unit but
    // two code units) — converting before every map lookup keeps anchors
    // matchable after emoji. Returns the unit containing the UTF-16 index.
    const unitAt = (utf16Idx) => {
        let offset = 0;
        for (let i = 0; i < units.length; i++) {
            if (utf16Idx < offset + units[i].ch.length) return units[i];
            offset += units[i].ch.length;
        }
        return undefined;
    };
    return { source, normalized: units.map(x => x.ch).join(''), map: units, unitAt };
}

/**
 * Grapheme-aware normalization with a position map back into the source
 * string. Shared by the flat-text matcher (findAnchorInText), the DOM text
 * index (text-index.js), and the fuzzy resolver so every surface applies the
 * SAME normalization policy (NFC, case, quotes/dashes, whitespace collapse)
 * with UTF-16 source spans as the common currency. `unitAt` converts a
 * UTF-16 index in `normalized` to its map entry — the two disagree once an
 * astral char (emoji) is present, so consumers must never index `map`
 * directly with string offsets.
 */
export function normalizedWithMap(value) {
    const source = String(value ?? '');
    const cached = _mapCache.get(source);
    if (cached) {
        // Map recency: delete+set moves the hit to the tail (LRU).
        _mapCache.delete(source);
        _mapCache.set(source, cached);
        return cached;
    }
    const map = _buildNormalizedMap(source);
    _mapCache.set(source, map);
    if (_mapCache.size > _MAP_CACHE_MAX) _mapCache.delete(_mapCache.keys().next().value);
    return map;
}

/** Find the first whole-phrase exact-normalized match and return original text. */
export function findAnchorInText(text, anchor, fromIndex = 0) {
    const needle = normalizeAnchorKey(anchor);
    if (!needle) return null;
    const mapped = normalizedWithMap(text);
    let pos = mapped.normalized.indexOf(needle);
    const floor = Number.isFinite(Number(fromIndex)) ? Math.max(0, Number(fromIndex)) : 0;
    while (pos >= 0) {
        const endNorm = pos + needle.length;
        const first = mapped.unitAt(pos);
        const last = mapped.unitAt(endNorm - 1);
        if (first && last) {
            const start = first.start;
            const end = last.end;
            if (start >= floor && !isWordChar(mapped.source[start - 1]) && !isWordChar(mapped.source[end])) {
                return { text: mapped.source.slice(start, end), start, end };
            }
        }
        pos = mapped.normalized.indexOf(needle, pos + 1);
    }
    return null;
}

export function findAllAnchorSpans(text, anchor) {
    const spans = [];
    let from = 0;
    for (;;) {
        const hit = findAnchorInText(text, anchor, from);
        if (!hit) return spans;
        spans.push(hit);
        from = hit.end > hit.start ? hit.end : hit.start + 1;
    }
}
