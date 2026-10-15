// @ts-check
/**
 * Glosses — Parser module
 * Parses model output → footnote objects, validates anchors against the post
 * text, and normalizes ordering + indices.
 *
 * Ported 1:1 from SillyTavern-Footnotes (parseResponse/parseTextFootnotes/
 * validateFootnotes/resolveAnchor/findExact/findRussianInflected/
 * normalizeFootnotes + the superscript helpers).
 *
 * NOTE: the original single-pass `JSON.parse` + text fallback is preserved here
 * for behavioural parity in stage 1. The stage-2 upgrade swaps this for the
 * multi-pass JSON-repair parser (see TODO in parseResponse).
 */

import { warn } from './core.js';
import { findAnchorInText, normalizeAnchorKey } from './anchor-utils.js';

// ── Superscript helpers ──
const _SUP_TO_DIGIT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
const _DIGIT_TO_SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

export function superscriptToIndex(value) {
    const digits = [...String(value || '')].map(ch => _SUP_TO_DIGIT[ch] ?? '').join('');
    return parseInt(digits, 10) || NaN;
}

export function indexToSuperscript(n) {
    return String(n).split('').map(d => _DIGIT_TO_SUP[parseInt(d)] || d).join('');
}

// ── Targeted-footnote symbols ──
// Targeted footnotes (the «Точечно» tab) are marked with the classical
// typographic sequence for unnumbered notes instead of superscript digits,
// so they never collide with the 1..N numbering of regular footnotes.
const TARGETED_SYMBOLS = ['*', '†', '‡', '§', '‖', '¶'];

/**
 * Marker symbol for the n-th targeted footnote (1-based). After the 6th the
 * sequence doubles, triples, … (⁂-style convention): **, ††, then ***, ††† —
 * the run count is Math.floor((n-1)/6)+1 and the symbol cycles inside it.
 */
export function indexToTargetedSymbol(n) {
    const num = Math.max(1, parseInt(n, 10) || 1);
    const symbol = TARGETED_SYMBOLS[(num - 1) % TARGETED_SYMBOLS.length];
    const repeats = Math.floor((num - 1) / TARGETED_SYMBOLS.length) + 1;
    return symbol.repeat(repeats);
}

/**
 * Strip a leading footnote number (superscript or ASCII digit, e.g. `⁴ ` or `4 `)
 * from the text so the panel can show the index separately as a mono accent
 * without rendering it twice. Mirrors the regex used by the inline editor.
 */
export function stripLeadingNumber(text) {
    return String(text || '').replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹\d]+\s*/u, '');
}

/**
 * Extract the first balanced `{...}` object from `text`, ignoring braces inside
 * string literals. More robust than the old /\{[\s\S]*\}/ (greedy to the LAST
 * `}`): if the model appends prose containing `}` after the JSON, the greedy
 * match swallowed it and JSON.parse fell through to the text fallback, losing
 * the footnotes structure. Returns the substring or ''.
 */
function extractFirstJsonBlock(text) {
    const t = String(text || '');
    const start = t.indexOf('{');
    if (start < 0) return '';
    const end = findMatchingBrace(t, start);
    return end > 0 ? t.slice(start, end + 1) : '';
}

// ── JSON repair (4-tier escalating strategy) ──
// Ported from DS Comments/parser.js. The prompt asks for strict JSON, but
// models routinely emit: reasoning blocks (<think>), markdown fences, missing
// commas, trailing commas, unescaped bare newlines inside strings, premature
// truncation, or one corrupt footnote that poisons the whole array. These
// helpers repair such output. Safe: byte-identical on valid JSON input.

/**
 * Strip reasoning blocks from LLM output.
 * Handles <think>/<thinking>/<reflection> (paired and unpaired open tags).
 */
function stripReasoningBlocks(text) {
    if (!text) return text;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    text = text.replace(/<reflection>[\s\S]*?<\/reflection>/gi, '');
    return text.replace(/^\s+/, '');
}

/**
 * Lightweight JSON repair — fix common LLM formatting errors (missing commas,
 * trailing commas, bare newlines inside strings, stray control chars).
 * Safe: byte-identical on valid JSON input.
 */
function tryRepairJson(text) {
    const out = [];
    let inStr = false;
    let esc = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (esc) { out.push(ch); esc = false; continue; }
        if (ch === '\\' && inStr) { out.push(ch); esc = true; continue; }

        if (inStr) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
            // Escape any other raw control char (0x00-0x1f) inside strings.
            if (ch < ' ') {
                if (ch === '\b') out.push('\\b');
                else if (ch === '\f') out.push('\\f');
                else out.push('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
                continue;
            }
            if (ch === '"') {
                // Look ahead past whitespace to decide if this " closes the string.
                let j = i + 1;
                while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
                const next = text[j];
                if (next === ',' || next === '}' || next === ']' || next === ':') {
                    inStr = false; out.push(ch); continue;
                }
                // Another " follows → missing comma before next key/value.
                if (next === '"') {
                    inStr = false; out.push(ch); out.push(','); continue;
                }
                inStr = false; out.push(ch); continue;
            }
            out.push(ch);
            continue;
        }

        if (ch === '"') { inStr = true; out.push(ch); continue; }

        // After } or ], insert missing comma before next value/key.
        if (ch === '}' || ch === ']') {
            let j = i + 1;
            while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
            const next = text[j];
            if (next === '"' || next === '{' || next === '[') {
                out.push(ch); out.push(','); continue;
            }
        }
        out.push(ch);
    }

    let result = out.join('');
    // Strip trailing commas before } or ] (common LLM mistake).
    result = result.replace(/,(\s*[}\]])/g, '$1');
    return result;
}

/**
 * Find the matching closing brace/bracket for the one at `start`, tracking
 * string context and escape sequences. Returns index of the matching close, or -1.
 */
function findMatchingBrace(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        if (ch === close) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

/**
 * Extract the footnotes array from a response object even when
 * the surrounding JSON structure is corrupt (premature ], missing commas,
 * mixed junk). Scans for individual footnote {…} objects via string/escape-aware
 * brace matching and parses each independently. Returns `{footnotes}` or null.
 */
function extractObjectsFromText(text) {
    const objects = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('{', i);
        if (start === -1) break;
        const end = findMatchingBrace(text, start);
        if (end === -1) { i = start + 1; continue; }
        const objText = text.slice(start, end + 1);
        let obj = null;
        try { obj = JSON.parse(objText); }
        catch {
            try { obj = JSON.parse(tryRepairJson(objText)); }
            catch { /* skip this object */ }
        }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) objects.push(obj);
        i = end + 1;
    }
    if (objects.length === 0) return null;
    // Each extracted object is a single footnote. Wrap them in the direct shape
    // parseResponse returns.
    return { footnotes: objects };
}

// ── Response parsing ──

/**
 * Parse raw model output into the direct `{footnotes}` payload. Legacy response
 * fields are tolerated on input but discarded; validation relies only on each
 * footnote's exact-normalized anchor against the current post.
 *
 * @returns {{footnotes:Array<{index:number, anchor:string, text:string}>}|null}
 */
export function parseResponse(raw) {
    if (!raw?.trim()) return null;
    // stripReasoningBlocks handles <think>/<thinking>/<reflection> (paired and
    // unpaired) — broader than the old <think>-only strip. Reasoning models
    // prefix their JSON with a thinking block that would otherwise poison the
    // JSON.parse. Ported from DS Comments.
    let cleaned = stripReasoningBlocks(raw).trim();
    // Strip BOM + markdown code fences (models sometimes wrap JSON in ```json).
    if (cleaned.charCodeAt(0) === 0xFEFF) cleaned = cleaned.slice(1);
    cleaned = cleaned.replace(/^```\w*\s*\n?/gm, '').replace(/```\s*$/gm, '').trim();
    if (cleaned.length > 100_000) return null;   // guard against pathological parses

    // JSON parse — the direct prompt asks for {"footnotes":[...]}.
    // We attempt repair on TWO surfaces and pick the one yielding more
    // footnotes:
    //   1. The balanced block from extractFirstJsonBlock (cleanly skips leading
    //      prose like "Here are the footnotes:").
    //   2. The whole cleaned text (so object-extraction finds ALL footnote
    //      objects even when the array envelope is missing or corrupt).
    const block = extractFirstJsonBlock(cleaned);
    const surfaces = block ? [block, cleaned] : [cleaned];

    let best = null;   // { footnotes } with the most recoverable footnotes
    for (const jsonStr of surfaces) {
        const parsed = parseJsonWithRepair(jsonStr);
        if (!parsed) continue;
        const arr = parsed?.footnotes;
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const footnotes = arr.map(f => {
            // Models often return plain-text footnote lines as strings inside
            // the JSON array instead of {anchor, text} objects. When f is a
            // string, f.anchor resolves to the deprecated String.prototype.anchor
            // function (not undefined), so the object path below would throw
            // TypeError on .trim(). Parse strings with the same per-line logic
            // as the text fallback so validation can run on them.
            if (typeof f === 'string') return parseTextFootnoteLine(f);
            // String() coercion: a non-string anchor/text (number, object — a
            // contract-violating model) would otherwise throw on .trim() and
            // poison the WHOLE footnotes array instead of one bad entry.
            const anchor = String(f.anchor ?? '').trim();
            let text = String(f.text ?? '').trim();
            // The "anchor" must stay verbatim; brackets inside text would
            // duplicate the anchor, so strip them when present.
            if (anchor) text = text.replace(/\s*\[[^\]]+\]/g, '');
            return { index: parseInt(f.index) || 1, anchor, text };
        }).filter(f => f && f.text);
        if (footnotes.length && (!best || footnotes.length > best.footnotes.length)) {
            best = { footnotes };
        }
    }
    if (best) return best;

    // Text fallback for legacy plain-line output.
    const textFns = parseTextFootnotes(cleaned);
    return textFns ? { footnotes: textFns } : null;
}

/**
 * Parse a JSON string into a footnotes response using a 4-tier escalating
 * repair strategy. Returns null if all attempts fail (caller falls through to
 * the text parser). Ported from DS Comments/parser.js.
 *
 *   1. Direct JSON.parse — valid JSON
 *   2. tryRepairJson + parse — missing commas, trailing commas, bare newlines
 *   3. Object extraction — scans for individual {…} objects, ignores structure
 *   4. Truncated recovery — appends closers for cut-off responses
 */
function parseJsonWithRepair(text) {
    // ── Attempt 1: direct parse ──
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* escalate */ }

    // ── Attempt 2: repair + parse ──
    if (!parsed) {
        try { parsed = JSON.parse(tryRepairJson(text)); } catch { /* escalate */ }
    }

    // A top-level object with a footnotes array is a usable response.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Array.isArray(parsed.footnotes)) {
        return parsed;
    }

    // ── Attempt 3: object extraction (ignores array/object structure) ──
    // The model may have emitted bare footnote objects without the response
    // envelope, or jammed them together with junk. Scan for every
    // individual {…} object in the text and treat them as the footnotes array.
    const extracted = extractObjectsFromText(text);
    if (extracted) return extracted;

    // ── Attempt 4: truncated recovery ──
    try {
        const lastObjEnd = text.lastIndexOf('}');
        if (lastObjEnd > 0) {
            const truncated = text.slice(0, lastObjEnd + 1);
            let openBraces = 0, openBrackets = 0;
            for (const ch of truncated) {
                if (ch === '{') openBraces++;
                if (ch === '}') openBraces--;
                if (ch === '[') openBrackets++;
                if (ch === ']') openBrackets--;
            }
            if (openBrackets >= 1 && openBraces <= 1) {
                let repaired = truncated;
                if (openBraces > 0) repaired += '}';
                repaired += ']';
                try { return JSON.parse(repaired); }
                catch { return JSON.parse(tryRepairJson(repaired)); }
            }
        }
    } catch { /* fall through */ }

    return null;
}

/**
 * Parse a single footnote line (e.g. "¹ Term (cat.) — explanation").
 * Returns {index, anchor, text} or null if the line doesn't match.
 *
 * Extracted from parseTextFootnotes so parseResponse can reuse it for
 * string elements inside a JSON footnotes array.
 */
function parseTextFootnoteLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^([⁰¹²³⁴⁵⁶⁷⁸⁹]+|\d{1,3})(?:[.):]|)\s*(.+)$/u);
    if (!m) return null;
    const rawIdx = m[1];
    const body = m[2];
    const index = /^\d+$/.test(rawIdx) ? parseInt(rawIdx, 10) : superscriptToIndex(rawIdx);
    if (isNaN(index)) return null;

    let anchor = '';
    let displayText = trimmed;

    // Bracketed anchor: "¹ Label [anchor phrase] — ..."
    const bracketMatch = body.match(/^(.+?)\s*\[([^\]]+)\]/u);
    if (bracketMatch && bracketMatch[2].trim().length <= 80) {
        anchor = bracketMatch[2].trim();
        displayText = trimmed.replace(/\s*\[[^\]]+\]/, '');
    } else {
        // Otherwise take the label up to the first em-dash / paren.
        const anchorMatch = body.match(/^(.+?)\s*[\u2013\u2014(]/u);
        if (anchorMatch) {
            anchor = anchorMatch[1].trim();
            // Cap kept in sync with validateFootnotes' 'too long' guard. With
            // EXACTLY N count pressure (buildUserPrompt), the model emits short
            // discrete anchors (< 60), so this fires only on junk. See
            // 2026-07-02-glosses-hybrid-exactly-n-design.md §4.
            if (anchor.length > 60) anchor = '';
        }
    }
    return { index, anchor, text: displayText };
}

function parseTextFootnotes(raw) {
    const footnotes = [];
    for (const line of raw.split('\n')) {
        const fn = parseTextFootnoteLine(line);
        if (fn) footnotes.push(fn);
    }
    return footnotes.length ? footnotes : null;
}

// ── Anchor validation / resolution ──

// Extracts the anchor-post text from a user prompt built by buildUserPrompt.
// The marker name reflects the annotation role (see spec
// 2026-07-02-glosses-context-separation-design.md §2): [Annotate this post]
// is the ONLY block we validate anchors against. When this marker changes,
// buildUserPrompt's opening part must change in lockstep.
export function extractPostTextFromPrompt(prompt) {
    // The post block is `[Annotate this post:\n<text>]`. buildContextBlocks
    // builds it from extractPlainText output, which `.trim()`s the text — so
    // there is NO trailing `\n` before the closing `]` in the real emitter
    // (`[Annotate this post:\n${cleanText}]`). The terminator must therefore
    // treat the `\n` before `]` as OPTIONAL, or postText comes back empty and
    // every anchor is dropped as "not found" (the leak-and-drop storm seen in
    // the console: "Leaked candidates" + "Dropped invalid footnotes", all N).
    //
    // The close-bracket is anchored by what FOLLOWS it (`\n\n[` for the next
    // block, or end-of-string) via lookahead, not by consumption. This keeps a
    // `]` that appears MID-post (rare but real: `[somus]`, JSON fragments,
    // custom tags) from terminating the slice: the non-greedy `[\s\S]*?` halts
    // at the first `]`, the lookahead fails for an interior `]` (followed by
    // more post text, not `\n\n[`/`$`), and the engine extends until the real
    // closing bracket. The optional `\n?` then absorbs the trailing newline
    // when one IS present (hand-built prompts / tests), so the captured post
    // text has no trailing `\n` in either form.
    const m = String(prompt || '').match(/^\[Annotate this post:\n([\s\S]*?)\n?\](?=\n\n\[|$)/);
    return m ? m[1] : '';
}

/**
 * Validate a direct `{footnotes}` payload — or a legacy plain array —
 * against an explicit post text. Validation uses the shared
 * exact-normalized whole-phrase matcher; unrelated legacy fields are
 * ignored. When `resolveFallback` is supplied it is consulted for anchors
 * the exact matcher misses (the generator passes the fuzzy resolver over
 * the DOM text index) and may rescue the footnote by returning its own
 * {text, start, end} hit.
 *
 * @returns {Array<{index,anchor,text}>|null}
 */
export function validateFootnotesAgainstText(parsed, postText, forcedIgnore = [], resolveFallback = null) {
    const isStructured = parsed && !Array.isArray(parsed)
        && Array.isArray(parsed.footnotes);
    const footnotes = isStructured ? parsed.footnotes : parsed;
    if (!Array.isArray(footnotes) || footnotes.length === 0) return null;
    const forbidden = new Set((Array.isArray(forcedIgnore) ? forcedIgnore : [])
        .map(normalizeAnchorKey).filter(Boolean));
    const seen = new Set();
    const dropped = [];

    const valid = footnotes
        .map(f => ({
            index: parseInt(f.index, 10) || 1,
            anchor: String(f.anchor || '').trim(),
            text: String(f.text || '').trim(),
        }))
        .filter(f => {
            if (!f.text || !f.anchor) { dropped.push({ anchor: f.anchor, reason: 'empty' }); return false; }
            if (f.anchor.length > 120) { dropped.push({ anchor: f.anchor, reason: 'too long' }); return false; }

            const hit = findAnchorInText(postText, f.anchor)
                ?? (typeof resolveFallback === 'function' ? resolveFallback(f.anchor) : null);
            if (!hit) { dropped.push({ anchor: f.anchor, reason: 'not found' }); return false; }
            f.anchor = hit.text;
            const key = normalizeAnchorKey(f.anchor);
            if (forbidden.has(key)) { dropped.push({ anchor: f.anchor, reason: 'forced ignore' }); return false; }
            if (seen.has(key)) { dropped.push({ anchor: f.anchor, reason: 'dup' }); return false; }
            seen.add(key);
            return true;
        });

    if (dropped.length) warn('Dropped invalid footnotes:', dropped);
    return valid.length ? valid : null;
}

/**
 * Prompt-shaped wrapper: extract the [Annotate this post] block and validate
 * against it. The generator prefers validateFootnotesAgainstText with the
 * DOM text index (the same surface the renderer matches on); this wrapper
 * remains for callers without a rendered element (Node tests, fallbacks).
 */
export function validateFootnotes(parsed, userPrompt, forcedIgnore = [], resolveFallback = null) {
    return validateFootnotesAgainstText(parsed, extractPostTextFromPrompt(userPrompt), forcedIgnore, resolveFallback);
}

/**
 * Re-number footnotes 1..N in document order (by anchor position in the post
 * text) and rewrite the leading superscript index on each text body.
 */
export function normalizeFootnotes(footnotes, plainText) {
    if (!footnotes?.length) return null;

    const withPos = footnotes.map(f => ({
        f,
        pos: findAnchorInText(plainText, f.anchor)?.start ?? -1,
    }));
    withPos.sort((a, b) => {
        if (a.pos >= 0 && b.pos >= 0) return a.pos - b.pos;
        if (a.pos >= 0) return -1;
        if (b.pos >= 0) return 1;
        return (a.f.index || 0) - (b.f.index || 0);
    });

    return withPos.map(({ f }, i) => {
        const newIndex = i + 1;
        const sup = indexToSuperscript(newIndex);
        const body = stripLeadingNumber(f.text).trim();
        return { ...f, index: newIndex, text: body ? `${sup} ${body}` : sup };
    });
}
