// @ts-check
/**
 * Glosses — Footnote text formatting helpers.
 *
 * Extracted verbatim from renderer.js (R-7.3 module split). Consumers:
 * renderer (inline block), footnote-popup (reading view), window.js (rows).
 */

import { sanitize } from './core.js';

// ══════════════════════════════════════════════════════════════════════════════
// FOOTNOTE TEXT FORMATTING (mini-markdown + sanitize)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Mini-markdown → safe HTML for footnote bodies, applied AFTER DOMPurify.
 * Supports: **bold**, *italic*, `code`, ~~strikethrough~~, [text](url) links,
 * fenced ``` blocks (stripped to plain text — mini-markdown has no <pre>),
 * \n → <br>. Single pass.
 *
 * Order matters: sanitize FIRST (kills any <img>/<a>/<script> the model
 * emitted), THEN transform inline markers into known-safe tags. The markdown
 * replacements only ever produce <strong>/<em>/<code>/<del>/<a>/<br>, which
 * are never stripped by a subsequent sanitize. Ported from DS Comments'
 * formatMessageContent.
 *
 * Links: the [text](url) pass runs before the other markers and emits
 * <a href="…" target="_blank" rel="noopener noreferrer">. Safety contract
 * mirrors the other passes: the URL group must start with http(s):// (no
 * javascript: or data:) and may not contain whitespace, quotes or <>"`*~
 * — so it cannot break out of the href attribute, inject tags, or be
 * mangled by the later bold/italic/code/del passes. Bare ')' is excluded
 * from the URL; a ')' inside it must balance its own '(' (CommonMark-style),
 * so prose like "([docs.x](https://docs.x))" doesn't swallow the outer ')'
 * into the href.
 *
 * @param {string} text - raw footnote text from the model/cache
 * @returns {string} sanitized HTML safe for innerHTML
 */
export function formatFootnoteText(text) {
    let out = sanitize(text);
    // Markdown links: [text](https://…) → real anchor. URL charset excludes
    // whitespace/quotes/<>"`*~ (see docblock); a parenthesized URL path must
    // balance its parens, the closing ')' of the markdown always terminates.
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()<>\"'`*~]|\([^\s()<>\"'`*~]*\))+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    // Fenced code blocks: strip ``` (and optional language tag) so the inline-code
    // regex below doesn't wrap the whole block in one giant <code>. Must run
    // before the inline-code pass.
    out = out.replace(/```[a-zA-Z0-9]*\n?/g, '');
    // Inline code: `text`  (do before italic so backticks survive)
    out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
    // Italic: *text*  (single asterisks not part of bold)
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
    out = out.replace(/\n/g, '<br>');
    return out;
}

/**
 * Split a dictionary-style footnote into its headword and the definition
 * proper, at the first spaced " — " / " – " separator the generator emits:
 *   "Нотный стан (англ.) — musical staff / stave · …"
 *     → head: "Нотный стан (англ.)"   body: "musical staff / stave · …"
 * Returns null when there is no separator, the text is multi-line, the head
 * is implausibly long (>80 chars — that's a sentence, not a headword), or
 * the body would be empty; callers then render the whole text as the body.
 * Operates on the RAW text (before formatFootnoteText) so markdown in either
 * half formats independently. Unspaced dashes ("red—hot") don't split.
 */
export function splitFootnoteHead(raw) {
    const text = String(raw ?? '').trim();
    if (!text || text.includes('\n')) return null;
    let sep = -1;
    for (const dash of [' — ', ' – ']) {
        const i = text.indexOf(dash);
        if (i !== -1 && (sep === -1 || i < sep)) sep = i;
    }
    if (sep <= 0) return null;
    const head = text.slice(0, sep).trim();
    const body = text.slice(sep + 3).trim();
    if (!head || !body || head.length > 80) return null;
    return { head, body };
}

