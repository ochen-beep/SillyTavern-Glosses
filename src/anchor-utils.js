// @ts-check
/** Shared exact-normalized anchor matching policy. */

function normalizeChar(ch) {
    return ch
        .normalize('NFC')
        .replace(/[\u2018\u2019\u201A\u201B']/gu, "'")
        .replace(/[\u201C\u201D\u201E\u201F«»"]/gu, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212-]/gu, '-');
}

export function normalizeAnchorKey(value) {
    return String(value ?? '')
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019\u201A\u201B']/gu, "'")
        .replace(/[\u201C\u201D\u201E\u201F«»"]/gu, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212-]/gu, '-')
        .replace(/\s+/gu, ' ');
}

export function isWordChar(ch) {
    if (!ch) return false;
    try { return /[\p{L}\p{N}_]/u.test(ch); }
    catch { return /[A-Za-z0-9_А-Яа-яЁё]/u.test(ch); }
}

/**
 * Grapheme-aware normalization with a position map back into the source
 * string. Shared by the flat-text matcher (findAnchorInText), the DOM text
 * index (text-index.js), and the fuzzy resolver so every surface applies the
 * SAME normalization policy (NFC, case, quotes/dashes, whitespace collapse)
 * with UTF-16 source spans as the common currency.
 */
export function normalizedWithMap(value) {
    const source = String(value ?? '');
    const pieces = [];
    let segmenter;
    try { segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { /* older engine */ }
    if (segmenter) {
        for (const part of segmenter.segment(source)) pieces.push({ text: part.segment, start: part.index, end: part.index + part.segment.length });
    } else {
        for (let i = 0; i < source.length; i++) pieces.push({ text: source[i], start: i, end: i + 1 });
    }

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
    return { source, normalized: units.map(x => x.ch).join(''), map: units };
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
        const first = mapped.map[pos];
        const last = mapped.map[endNorm - 1];
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

/** Parse one non-empty target per line, preserving first spelling and order. */
export function normalizeLineTargets(value, limit = 20) {
    const targets = [];
    const seen = new Set();
    let duplicateCount = 0;
    let truncatedCount = 0;
    for (const line of String(value ?? '').split(/\r?\n/u)) {
        const target = line.trim();
        if (!target) continue;
        const key = normalizeAnchorKey(target);
        if (seen.has(key)) { duplicateCount++; continue; }
        seen.add(key);
        if (targets.length >= limit) { truncatedCount++; continue; }
        targets.push(target);
    }
    return { targets, duplicateCount, truncatedCount };
}
