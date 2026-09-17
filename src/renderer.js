// @ts-check
/**
 * Glosses — Renderer module
 * DOM highlighting (anchor wrapping), footnote popup, regenerate button, spinner.
 *
 * Ported 1:1 from SillyTavern-Footnotes. The anchor-walking TreeWalker, the
 * pointerup/click touch-toggle trick, and the popup positioning all stay as-is.
 *
 * The big bug fix carried over from the review: buildAnchorRegex now uses SINGLE
 * backslashes in its String.raw lookbehind/lookahead so \p{L} actually matches
 * Unicode letters (the original double-escaped \p silently broke the regex and
 * always fell through to the ASCII-only \b branch — bad for Cyrillic/CJK text).
 */

import { S, getCtx, t, escapeRegex, sanitize, warn } from './core.js';
import { getVariantFootnotes, getVariantPayload, digestFor } from './cache.js';
import { targetedOf } from './domain/footnote-payload.js';
import { isTranslatedView } from './domain/message-identity.js';
import { indexToSuperscript, indexToTargetedSymbol, stripLeadingNumber } from './parser.js';
import { findAllAnchorSpans, normalizeAnchorKey } from './anchor-utils.js';
import { buildTextIndex, segmentsFor } from './text-index.js';
import { rankOccurrencesByContext } from './domain/rebind.js';
import { iconHtml } from './ui/icons.js';
import { buildFootnoteActions } from './ui/footnote-actions.js';
import { applyCustomCss } from './ui/custom-css.js';

// ══════════════════════════════════════════════════════════════════════════════
// FOOTNOTE TEXT FORMATTING (mini-markdown + sanitize)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Mini-markdown → safe HTML for footnote bodies, applied AFTER DOMPurify.
 * Supports: **bold**, *italic*, `code`, ~~strikethrough~~, fenced ``` blocks
 * (stripped to plain text — mini-markdown has no <pre>), \n → <br>. Single pass.
 *
 * Order matters: sanitize FIRST (kills any <img>/<a>/<script> the model
 * emitted), THEN transform inline markers into known-safe tags. The markdown
 * replacements only ever produce <strong>/<em>/<code>/<del>/<br>, which are
 * never stripped by a subsequent sanitize. Ported from DS Comments'
 * formatMessageContent.
 *
 * @param {string} text - raw footnote text from the model/cache
 * @returns {string} sanitized HTML safe for innerHTML
 */
export function formatFootnoteText(text) {
    let out = sanitize(text);
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

// ══════════════════════════════════════════════════════════════════════════════
// HIGHLIGHT INJECTION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Wrap every footnote anchor inside the message's .mes_text in a .gls-marker
 * span, attaching the popup handlers. Removes any previous markers first so
 * re-injection (swipe / regen) is idempotent.
 */
/**
 * Build (or replace) the inline footnote block as the last child of
 * `.mes_block` — INSIDE the message column but OUTSIDE `.mes_text`, so
 * markdown/stream renderers (which rewrite `.mes_text` only) don't wipe it
 * on re-render / swipe. `.mes` itself is a flex ROW (all supported ST
 * versions), so appending there — as pre-3.3 did — made the block a side
 * column next to the text instead of a block under it. Same hosting pattern
 * ST uses for `.mes_reasoning_details`. Called only from injectHighlights
 * when displayMode ∈ {inline, both}. Footnotes are rendered in their natural
 * order (by `fn.index`); missing index becomes the natural array position so
 * legacy unparsed payloads still get a numbered block.
 */
function renderInlineBlock(mesEl, footnotes) {
    const host = mesEl.querySelector(':scope > .mes_block') || mesEl;
    const existing = host.querySelector(':scope > .gls-inline-fns');
    // Pre-3.3 blocks sit directly under .mes (flex row — misplaced). Strip
    // any legacy placement so an upgrade re-homes the block on next inject.
    mesEl.querySelectorAll(':scope > .gls-inline-fns').forEach(el => {
        if (el !== existing) el.remove();
    });
    if (!footnotes?.length) {
        existing?.remove();
        return;
    }
    // Numbered regular footnotes first (by index), then targeted entries in
    // their positional order — the classical typographic layout where the
    // symbol run follows the numeric run.
    const regular = footnotes
        .filter(f => f.kind !== 't')
        .sort((a, b) => (parseInt(a.index, 10) || 0) - (parseInt(b.index, 10) || 0));
    const targeted = footnotes.filter(f => f.kind === 't');
    const ordered = [...regular, ...targeted];
    const block = existing || document.createElement('div');
    block.className = 'gls-inline-fns';
    block.setAttribute('aria-label', t('Footnotes'));
    block.innerHTML = '';
    for (const fn of ordered) {
        const isTargeted = fn.kind === 't';
        const p = document.createElement('p');
        p.className = 'gls-inline-fn';
        // Mirror the marker's identity (index + absent-kind-means-regular) so
        // a marker tap in inline mode can find its row via dataset matching.
        p.dataset.glsIndex = fn.index;
        if (isTargeted) p.dataset.glsKind = 't';
        const sup = document.createElement('sup');
        sup.className = 'gls-inline-fn-idx' + (isTargeted ? ' gls-sup--targeted' : '');
        // The panel/block owns the number (symbol for targeted); the text's own
        // leading numeric prefix is stripped so it is never rendered twice.
        sup.textContent = isTargeted
            ? indexToTargetedSymbol(fn.index)
            : indexToSuperscript(fn.index);
        const span = document.createElement('span');
        span.className = 'gls-inline-fn-text';
        span.innerHTML = formatFootnoteText(isTargeted ? fn.text : stripLeadingNumber(fn.text));
        p.appendChild(sup);
        p.appendChild(span);
        block.appendChild(p);
    }
    if (!existing) host.appendChild(block);
}

export function injectHighlights(mesEl, footnotes) {
    if (!mesEl) return;
    removeHighlights(mesEl);
    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText || !footnotes?.length) return;

    const withAnchor = footnotes.filter(f => f.anchor?.trim());
    if (!withAnchor.length) {
        // No anchors to highlight inside the text, but if the user picked the
        // `inline`/`both` displayMode we still emit the under-post block so
        // they can read the rendered footnotes (some legacy payloads have
        // text-only fns with no anchor).
        const mode = S().displayMode;
        if (mode === 'inline' || mode === 'both') renderInlineBlock(mesEl, footnotes);
        return;
    }

    // Longest anchors first so "Son of Horus" matches before "Son" alone.
    const sorted = [...withAnchor].sort((a, b) => b.anchor.length - a.anchor.length);
    const report = wrapAnchors(mesText, sorted);

    // §4.2: in inline / both modes, append (or refresh) the under-post block
    // so the user can READ the footnote text — without it, `inline` reduced
    // to "highlights with no content" (the bug). Block lives on `.mes_block`
    // (last child), not `.mes_text`, so ST's markdown / streaming renderers
    // can't wipe it — and not `.mes`, which is a flex row.
    const mode = S().displayMode;
    if (mode === 'inline' || mode === 'both') renderInlineBlock(mesEl, footnotes);
    return report;
}

/**
 * Rank an anchor's occurrences by the footnote's stored context selectors
 * (W3C TextQuoteSelector style, computed at save time). Occurrences whose
 * surrounding text matches the stored prefix/suffix sort first, so a
 * re-injection after an edit lands on the occurrence the anchor was
 * originally placed on instead of jumping to the first match. Falls back to
 * document order when nothing matches (heavily edited text).
 *
 * Moved to domain/rebind.js (pure) so the rebind engine and the renderer
 * share ONE ranking policy; re-exported here for the wrap-time call below.
 */
export { rankOccurrencesByContext } from './domain/rebind.js';

/**
 * Place every footnote's marker against the message's text INDEX (one
 * concatenated string over the DOM's text nodes) instead of per-text-node
 * matching. An anchor crossing an inline-element boundary (<em>, <code>, …)
 * now yields a multi-piece marker — one .gls-marker span per crossed node —
 * where the old per-node walker silently dropped it.
 *
 * Placement is a single greedy sweep over all (footnote, occurrence) pairs
 * in document order (start asc, length desc) — the same policy the old
 * per-node code applied, now global — and returns a report so footnotes
 * that end up without a marker are observable instead of silent.
 */
function wrapAnchors(mesText, sortedFns) {
    const report = { placed: 0, unmatched: [] };
    let index = null;
    try { index = buildTextIndex(mesText); } catch { index = null; }
    if (!index) {
        report.unmatched = sortedFns.map(fn => ({ index: fn.index, anchor: fn.anchor, reason: 'index unavailable' }));
        warn('Glosses: text index unavailable, markers skipped:', report.unmatched);
        return report;
    }

    const perFn = [];
    for (const fn of sortedFns) {
        const key = normalizeAnchorKey(fn.anchor);
        if (!key) continue;
        const occurrences = rankOccurrencesByContext(findAllAnchorSpans(index.text, fn.anchor), fn, index.text);
        perFn.push({ fn, key, occurrences });
    }

    const flats = [];
    for (const p of perFn) for (const span of p.occurrences) flats.push({ fn: p.fn, key: p.key, ...span });
    flats.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const placed = new Map(); // key → winning flat candidate
    let end = 0;
    for (const candidate of flats) {
        if (placed.has(candidate.key) || candidate.start < end) continue;
        placed.set(candidate.key, candidate);
        end = candidate.end;
    }

    // Materialize right-to-left: splitting a node keeps its head in the
    // original node reference, so segments of spans further left (processed
    // later) keep valid (node, offset) pairs.
    const order = [...placed.values()].sort((a, b) => b.start - a.start);
    for (const candidate of order) {
        const segments = segmentsFor(index, candidate.start, candidate.end);
        // Superscript rides the LAST piece: ST's markdown wraps «…» / "…"
        // quotes in <q>, splitting the anchor's text nodes mid-phrase, and a
        // sup on the first piece would land before the quoted term.
        const primaryIdx = segments.length - 1;
        segments.forEach((seg, i) => wrapSegment(seg, candidate.fn, i === primaryIdx));
    }

    report.placed = placed.size;
    report.unmatched = perFn
        .filter(p => !placed.has(p.key))
        .map(p => ({ index: p.fn.index, anchor: p.fn.anchor, reason: p.occurrences.length ? 'overlap' : 'not found' }));
    if (report.unmatched.length) warn('Footnotes without markers:', report.unmatched);
    return report;
}

/**
 * Wrap one segment (a run inside a single text node) of a footnote's span.
 * Splitting isolates the exact run; the run is then replaced by the marker
 * piece. The primary piece (the LAST one — see wrapAnchors) carries the
 * superscript; every earlier piece gets a continuation class (same styling,
 * no superscript) so a phrase crossing element boundaries still reads as one
 * anchor.
 */
function wrapSegment(seg, fn, primary) {
    const node = seg.node;
    let target = node;
    if (seg.start > 0) target = node.splitText(seg.start);
    if (seg.end - seg.start < (target.nodeValue ?? '').length) target.splitText(seg.end - seg.start);
    const run = target.nodeValue ?? '';
    const piece = createMarker(fn, run, primary);
    target.parentNode.replaceChild(piece, target);
}

/**
 * Build one marker piece: shows the verbatim anchor text run and (unless
 * displayMode is 'inline') the primary piece appends a superscript index.
 *
 * No per-marker listeners — popup opens via a single delegated listener on #chat
 * (installMarkerDelegation), so a long chat with hundreds of markers costs O(1)
 * listeners instead of O(N).
 */
function createMarker(fn, sourceText, primary = true) {
    const isTargeted = fn.kind === 't';
    const span = document.createElement('span');
    span.className = 'gls-marker';
    if (!primary) span.classList.add('gls-marker-cont');
    span.dataset.glsIndex = fn.index;
    // Absent glsKind means a regular footnote — markers written before the
    // targeted feature (and any hand-built fn object) keep resolving.
    if (isTargeted) span.dataset.glsKind = 't';
    span.textContent = sourceText;

    if (primary && S().displayMode !== 'inline') {
        const sup = document.createElement('sup');
        sup.className = 'gls-sup' + (isTargeted ? ' gls-sup--targeted' : '');
        sup.textContent = isTargeted ? indexToTargetedSymbol(fn.index) : indexToSuperscript(fn.index);
        span.appendChild(sup);
    }

    return span;
}

// ══════════════════════════════════════════════════════════════════════════════
// DELEGATED MARKER CLICK → POPUP (O(1) listeners for the whole chat)
// ══════════════════════════════════════════════════════════════════════════════

let _delegationInstalled = false;
let _delegationRoot = null;

/**
 * Mount a single pointerup + click listener on #chat. Resolves the clicked
 * marker → its message's footnote by index → showPopup. Idempotent; safe to
 * call on app-ready and on chat-changed.
 *
 * The installed #chat node is retained so uninstallMarkerDelegation() always
 * detaches from the SAME node, even if SillyTavern later replaced #chat. The
 * previous version looked up #chat again at uninstall time and silently missed
 * listeners bound to a now-detached node.
 */
export function installMarkerDelegation() {
    if (_delegationInstalled) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    _delegationInstalled = true;
    _delegationRoot = chat;
    chat.addEventListener('pointerup', onDelegatedPointerUp);
    chat.addEventListener('click', onDelegatedClick);
}

export function uninstallMarkerDelegation() {
    if (!_delegationInstalled) return;
    const chat = _delegationRoot;
    if (chat) {
        chat.removeEventListener('pointerup', onDelegatedPointerUp);
        chat.removeEventListener('click', onDelegatedClick);
    }
    _delegationInstalled = false;
    _delegationRoot = null;
}

function resolveFootnoteFromMarker(marker) {
    const mesEl = marker.closest?.('.mes[mesid]');
    if (!mesEl) return null;
    const messageId = mesEl.getAttribute('mesid');
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return null;
    const swipeIdx = msg.swipe_id ?? 0;
    // Verified payload read: the digest gate guarantees the footnotes belong
    // to the variant currently shown, so the popup's Edit/Delete context is
    // correct by construction (mutateFootnotes re-checks before writing).
    const payload = getVariantPayload(messageId, swipeIdx);
    if (!payload) return null;
    const isTargeted = marker.dataset.glsKind === 't';
    const pool = isTargeted ? targetedOf(payload) : payload.footnotes;
    const idx = Number(marker.dataset.glsIndex);
    // Within one kind the index is unique, so the first match is THE match.
    const fn = pool.find(f => f.index === idx) || null;
    if (!fn) return null;
    // Return the cache context alongside the footnote so the popup can drive
    // Edit/Delete with the (msgId, swipeIdx, digest) staleness triple, plus
    // the kind so the commands mutate the right array.
    return { fn, msgId: messageId, swipeIdx, digest: payload.contentDigest, kind: isTargeted ? 't' : 'fn' };
}

/**
 * inline displayMode has no popup: a marker tap instead scrolls the message's
 * under-post block to the tapped footnote's row and flashes it, so a
 * number-less marker still resolves to its text. Matching rides the identity
 * datasets written by renderInlineBlock (index + absent-kind-means-regular,
 * same convention as markers).
 */
function revealInlineFootnote(marker) {
    const mesEl = marker.closest?.('.mes[mesid]');
    if (!mesEl) return;
    const block = mesEl.querySelector('.mes_block > .gls-inline-fns')
        || mesEl.querySelector('.gls-inline-fns');
    if (!block) return;
    const kindT = marker.dataset.glsKind === 't';
    const idx = String(marker.dataset.glsIndex);
    const entry = [...block.querySelectorAll('.gls-inline-fn')]
        .find(p => p.dataset.glsIndex === idx && (p.dataset.glsKind === 't') === kindT);
    if (!entry) return;
    // .mes_block is overflow:clip, so the scroll chains to #chat — the same
    // container the user scrolls anyway. Smooth degrades to instant on old
    // mobile engines; the flash still marks the landing row.
    entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    entry.classList.remove('gls-fn-flash');
    void entry.offsetWidth; // reflow restarts the animation on repeated taps
    entry.classList.add('gls-fn-flash');
    // The animation runs once and the class outlives it (fill-mode none — the
    // row's look is back to normal), but stale classes would accumulate across
    // taps; drop it when the animation ends.
    entry.addEventListener('animationend', () => entry.classList.remove('gls-fn-flash'), { once: true });
}

function onDelegatedPointerUp(e) {
    // Touch path: fire the popup on pointerup for instant response, then flag
    // the marker so the immediately-following click is suppressed.
    if (e.pointerType === 'mouse') return;
    const marker = e.target.closest?.('.gls-marker');
    if (!marker) return;
    e.stopPropagation();
    marker._glsTouchHandled = true;
    if (S().displayMode !== 'inline') {
        const resolved = resolveFootnoteFromMarker(marker);
        if (resolved) showPopup(resolved.fn, marker, resolved);
    } else {
        revealInlineFootnote(marker);
    }
}

function onDelegatedClick(e) {
    const marker = e.target.closest?.('.gls-marker');
    if (!marker) return;
    e.stopPropagation();
    if (marker._glsTouchHandled) { marker._glsTouchHandled = false; return; }
    if (S().displayMode !== 'inline') {
        const resolved = resolveFootnoteFromMarker(marker);
        if (resolved) showPopup(resolved.fn, marker, resolved);
    } else {
        revealInlineFootnote(marker);
    }
}

/**
 * Unwrap all .gls-marker spans in a message, restoring the original text node.
 * Uses normalize() to merge the fragmented text nodes back together.
 */
export function removeHighlights(mesEl) {
    if (!mesEl) return;
    mesEl.querySelectorAll('.gls-marker').forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        let txt = '';
        for (const child of span.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) txt += child.nodeValue;
        }
        parent.replaceChild(document.createTextNode(txt), span);
    });
    // §4.2: also strip the inline footnote block under this message — both
    // the current placement (`.mes_block` last child) and the pre-3.3 legacy
    // one (direct `.mes` child), so an upgrade cleans up misplaced blocks on
    // the next re-inject. The `:scope >` guards ensure we don't accidentally
    // remove a block that belongs to a nested message in some custom ST layout.
    mesEl.querySelectorAll(':scope > .gls-inline-fns, :scope > .mes_block > .gls-inline-fns')
        .forEach(el => el.remove());
    try { mesEl.normalize(); } catch { /* Safari quirk */ }
}

/**
 * Re-inject cached highlights for every AI message in the chat and re-add the
 * per-message regenerate button. Called on app-ready / chat-changed.
 *
 * Lazy: instead of walking all messages at once (O(chat) DOM work on a long
 * conversation), we observe messages with an IntersectionObserver and inject
 * only as they scroll into view. Visible-on-bootstrap messages are injected
 * synchronously so there's no flash on first paint.
 *
 * @param {boolean} [skipEnsureLazy=false] — when true (MORE_MESSAGES_LOADED
 *   re-entry), skip ensureLazyInjector() — it already exists from init.
 */
export function restoreHighlightsAll(skipEnsureLazy = false) {
    if (!skipEnsureLazy) ensureLazyInjector();
    document.querySelectorAll('.mes[mesid]').forEach(mesEl => restoreMessage(mesEl));
}

/**
 * Restore markers + regen button for a single message element. Idempotent —
 * addRegenButton checks for existing .gls-regen-btn; observeForLazyInject
 * guards against duplicate observation. Exported for MORE_MESSAGES_LOADED.
 */
export function restoreMessage(mesEl) {
    const messageId = mesEl.getAttribute('mesid');
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return;
    // User posts are restored (button + cached highlights) only when the
    // glossUserMessages setting is on.
    if (msg.is_user && !S().glossUserMessages) return;
    // The DOM is showing a translation (extra.display_text): markers must not
    // be wrapped around words of the translated view — anchors belong to the
    // original body. The regen button still mounts (it lives on the mes block,
    // not in the text).
    if (isTranslatedView(msg)) return;
    const swipeIdx = msg.swipe_id ?? 0;
    // Always (re)add the regen button — cheap, and independent of visibility.
    addRegenButton(messageId);
    // Mark as pending; the observer injects on entry. Visible-on-bootstrap
    // messages get an immediate inject so first paint isn't blank.
    if (!getVariantFootnotes(messageId, swipeIdx)) return;
    const vh = window.innerHeight;
    const rect = mesEl.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < vh;
    if (visible) injectIfCached(mesEl, messageId, swipeIdx);
    observeForLazyInject(mesEl);
}

/**
 * Re-run injection for every message that already carries a verified payload.
 * Used when a setting that shapes rendered output changes (displayMode: both
 * the marker's sup index and the under-post block depend on it) so posts
 * already on screen switch shape immediately instead of on their next
 * render/swipe/edit.
 *
 * Translate note: for a translated AI message (display_text = translation,
 * mes = original) the digest gate PASSES — the payload is keyed on `mes` —
 * but the screen shows the translation, so injection is skipped explicitly
 * via isTranslatedView (same rule as presentVariant/restoreMessage).
 */
export function reapplyHighlightsAll() {
    const ctx = getCtx();
    document.querySelectorAll('.mes[mesid]').forEach(mesEl => {
        const messageId = mesEl.getAttribute('mesid');
        const msg = ctx.chat?.[parseInt(messageId)];
        if (!msg) return;
        if (msg.is_user && !S().glossUserMessages) return;
        if (isTranslatedView(msg)) return;
        const swipeIdx = msg.swipe_id ?? 0;
        const cached = getVariantFootnotes(messageId, swipeIdx);
        if (cached?.length) {
            injectHighlights(mesEl, cached);
            return;
        }
        // No verified payload for the shown variant: strip leftovers so a mode
        // switch can't leave stale markers from an earlier state behind.
        if (mesEl.querySelector('.gls-marker, .gls-inline-fns')) removeHighlights(mesEl);
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// LAZY HIGHLIGHT INJECTION (IntersectionObserver-driven)
// ══════════════════════════════════════════════════════════════════════════════

let _lazyIO = null;
const _lazyPending = new Set();           // mesEls awaiting first visibility
const _lazyInjected = new WeakSet();      // mesEls already injected this chat

function ensureLazyInjector() {
    if (_lazyIO) return;
    _lazyIO = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const mesEl = entry.target;
            _lazyIO.unobserve(mesEl);
            _lazyPending.delete(mesEl);
            injectCachedForEl(mesEl);
        }
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });
}

function injectCachedForEl(mesEl) {
    if (!mesEl || _lazyInjected.has(mesEl)) return;
    const messageId = mesEl.getAttribute('mesid');
    if (!messageId) return;
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return;
    // Lazy inject is for cached highlights; user posts participate only when
    // glossUserMessages is on (mirrors restoreHighlightsAll's guard).
    if (msg.is_user && !S().glossUserMessages) return;
    // Never wrap markers around a translated view — see restoreMessage.
    if (isTranslatedView(msg)) return;
    const swipeIdx = msg.swipe_id ?? 0;
    injectIfCached(mesEl, messageId, swipeIdx);
    _lazyInjected.add(mesEl);
}

function injectIfCached(mesEl, messageId, swipeIdx) {
    const cached = getVariantFootnotes(messageId, swipeIdx);
    if (cached) injectHighlights(mesEl, cached);
}

function observeForLazyInject(mesEl) {
    if (!mesEl || _lazyInjected.has(mesEl) || _lazyPending.has(mesEl)) return;
    _lazyPending.add(mesEl);
    ensureLazyInjector();
    _lazyIO.observe(mesEl);
}

/** Reset the lazy injector's per-chat state. Call on chat-changed. */
export function resetLazyInjector() {
    _lazyIO?.disconnect();
    _lazyIO = null;
    _lazyPending.clear();
    // WeakSet can't be cleared, but its entries are GC'd once their mesEls
    // are dropped from the DOM after a chat switch.
}

// ══════════════════════════════════════════════════════════════════════════════
// ANCHOR REGEX
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build one combined regex matching any of the anchors at word boundaries.
 * Prefers Unicode-aware lookbehind/lookahead (\p{L}\p{N}) so Cyrillic/CJK and
 * other non-ASCII scripts get correct boundaries. Falls back to ASCII \b for
 * engines lacking lookbehind support.
 *
 * NOTE (review fix): the lookbehind/lookahead MUST use single backslashes —
 * `[\p{L}\p{N}_]`. The original `\p{L}` double-escape (in String.raw) became a
 * literal backslash-p, which either threw under the 'u' flag or matched the
 * letter "p", defeating the whole point and forcing the \b fallback.
 */
export function buildAnchorRegex(anchors) {
    if (!anchors.length) return null;
    const escaped = anchors.map(a => escapeRegex(a));
    try {
        const parts = escaped.map(e => String.raw`(?<![\p{L}\p{N}_])(${e})(?![\p{L}\p{N}_])`);
        return new RegExp(parts.join('|'), 'uig');
    } catch {
        const parts = escaped.map(e => `(\\b${e}\\b)`);
        return new RegExp(parts.join('|'), 'ig');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// HIGHLIGHT STYLES (CSS custom properties)
// ══════════════════════════════════════════════════════════════════════════════

// Footnote font stacks keyed by the footnoteFontFamily setting value. Each
// stack lists OS-available fonts only (no webfont loading): the leading name
// wins where installed, the tail is the cross-platform fallback. 'inherit'
// has no entry - unknown keys resolve to 'inherit', which is also the
// forward-compat path for settings written by future versions.
const FONT_STACKS = {
    serif: "Georgia, 'Times New Roman', serif",
    // Bookish long-form serif: Charter (macOS), Sitka Text (Windows, designed
    // for on-screen reading), Georgia elsewhere.
    charter: "'Charter', 'Bitstream Charter', 'Sitka Text', Sitka, Georgia, serif",
    // Old-style humanist serif: Palatino Linotype ships with Windows since
    // 2000, Palatino with macOS, URW Palladio with most Linux distros.
    palatino: "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', Georgia, serif",
    // Wide, high-x-height sans built for screen legibility - distinctly rounder
    // and airier than the ST theme font 'inherit' resolves to.
    verdana: "Verdana, Geneva, 'DejaVu Sans', sans-serif",
    mono: "ui-monospace, 'Cascadia Code', Consolas, Menlo, 'DejaVu Sans Mono', 'Courier New', monospace",
};

export function applyHighlightStyles() {
    const s = S();
    const root = document.documentElement;
    root.style.setProperty('--gls-hl-color', s.highlightColor);
    root.style.setProperty('--gls-hl-opacity', (s.highlightOpacity / 100).toFixed(2));
    // Two font pairs: footnoteFont* styles the footnote text on chat surfaces
    // (popup, inline block, popup snapshot); panelFont* styles the floating
    // panel chrome. Both family selects share FONT_STACKS.
    root.style.setProperty('--gls-font-family', FONT_STACKS[s.footnoteFontFamily] ?? 'inherit');
    root.style.setProperty('--gls-font-size', s.footnoteFontSize || '0.9em');
    root.style.setProperty('--gls-panel-font-family', FONT_STACKS[s.panelFontFamily] ?? 'inherit');
    root.style.setProperty('--gls-panel-font-size', s.panelFontSize || '0.9em');
    root.style.setProperty('--gls-marker-size', s.markerFontSize || '0.75em');
    root.style.setProperty('--gls-popup-maxw', `${parseInt(s.popupMaxWidth, 10) || 420}px`);
    // Popup geometry/depth knobs (density, shadow strength) and popup skins
    // ride classes on :root — each level maps to a fixed CSS rule, so a bad
    // stored value can only fall back to the unclassed default. Radius is a
    // continuous slider, so it publishes a px var instead.
    const skin = ['adaptive', 'paper', 'terminal', 'telegram', 'bubble', 'glass', 'codex', 'neon', 'vellum', 'inkwell', 'washi', 'tideglass', 'herbarium', 'marquee', 'rime', 'adobe', 'velvet', 'phosphor', 'rosewindow', 'mahou', 'moonjar', 'cinnabar', 'koyo', 'gloam', 'afterglow', 'starseed'].includes(s.popupTheme) ? s.popupTheme : 'adaptive';
    root.classList.remove('gls-popup-skin-adaptive', 'gls-popup-skin-paper', 'gls-popup-skin-terminal', 'gls-popup-skin-telegram', 'gls-popup-skin-bubble', 'gls-popup-skin-glass', 'gls-popup-skin-codex', 'gls-popup-skin-neon', 'gls-popup-skin-vellum', 'gls-popup-skin-inkwell', 'gls-popup-skin-washi', 'gls-popup-skin-tideglass', 'gls-popup-skin-herbarium', 'gls-popup-skin-marquee', 'gls-popup-skin-rime', 'gls-popup-skin-adobe', 'gls-popup-skin-velvet', 'gls-popup-skin-phosphor', 'gls-popup-skin-rosewindow', 'gls-popup-skin-mahou', 'gls-popup-skin-moonjar', 'gls-popup-skin-cinnabar', 'gls-popup-skin-koyo', 'gls-popup-skin-gloam', 'gls-popup-skin-afterglow', 'gls-popup-skin-starseed');
    root.classList.add(`gls-popup-skin-${skin}`);
    root.classList.toggle('gls-popup-compact', s.popupDensity === 'compact');
    root.classList.toggle('gls-popup-shadow-soft', s.popupShadow === 'soft');
    root.classList.toggle('gls-popup-shadow-none', s.popupShadow === 'none');
    const radius = parseInt(s.popupCornerRadius, 10);
    root.style.setProperty('--gls-popup-radius', Number.isFinite(radius) ? `${radius}px` : '12px');
    // Explicit font choice beats a skin's bundled font: skins set font-family
    // only via :not(.gls-font-forced), so this class gates them off.
    root.classList.toggle('gls-font-forced', Boolean(FONT_STACKS[s.footnoteFontFamily]));
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        chatEl.classList.remove('gls-hl-background', 'gls-hl-underline', 'gls-hl-dotted');
        chatEl.classList.add(`gls-hl-${s.highlightStyle || 'background'}`);
    }
    // Level 3 — user's custom CSS layer (raw + settings-preview mirror).
    // Rides this publish path so boot/enable/knob changes always carry it.
    applyCustomCss();
}

// ══════════════════════════════════════════════════════════════════════════════
// REGENERATE BUTTON + SPINNER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Add a per-message regenerate-footnotes button to the .mes_buttons row.
 * Idempotent — skips if already present.
 */
export function addRegenButton(messageId) {
    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesEl || mesEl.querySelector('.gls-regen-btn')) return;
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return;
    // User posts get the button only when the glossUserMessages setting is on
    // (manual-only footnotes for {{user}}). AI posts always get it.
    if (msg.is_user && !S().glossUserMessages) return;
    const mesBtns = mesEl.querySelector('.mes_buttons');
    if (!mesBtns) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button gls-regen-btn';
    btn.title = t('Regenerate footnotes');
    btn.innerHTML = '<i class="fa-solid fa-superscript"></i>';
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Lazy import to avoid a renderer↔generator cycle.
        const { state } = await import('./core.js');
        if (state.isGenerating[messageId]) {
            state.abortControllers[messageId]?.abort();
            return;
        }
        const swipeIdx = msg.swipe_id ?? 0;
        // Keep the previous highlights until the replacement validates and saves.
        const { generateFootnotes } = await import('./generator.js');
        await generateFootnotes(messageId, swipeIdx, mesEl);
    });

    const hint = mesBtns.querySelector('.extraMesButtonsHint');
    if (hint) mesBtns.insertBefore(btn, hint);
    else mesBtns.prepend(btn);
}

export function setSpinner(messageId, active) {
    const btn = document.querySelector(`.mes[mesid="${messageId}"] .gls-regen-btn`);
    if (!btn) return;
    if (active) {
        btn.classList.add('gls-busy');
        btn.title = t('Cancel generation');
    } else {
        btn.classList.remove('gls-busy');
        btn.title = t('Regenerate footnotes');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// FOOTNOTE POPUP
// ══════════════════════════════════════════════════════════════════════════════

let _currentPopup = null;
let _popupAnchor = null;
// True while the inline footnote editor is mounted in the popup body. While
// set, Escape is owned by the editor's Cancel (the textarea blur handler) and
// must NOT close the whole popup.
let _popupEditing = false;
// Owned deferred-registration timer for the popup's outside/Escape listeners.
// Cancelled on closePopup() so a teardown mid-delay cannot leak listeners.
let _popupOpenTimer = null;
// rAF ticket for the popup's follow-the-anchor pass (chat scroll / window
// resize). Zero = idle; cancelled in closePopup() so a teardown mid-frame
// cannot position a removed popup.
let _popupFollowRaf = 0;

/**
 * Refresh the floating panel after a popup-side mutation (edit / delete): the
 * panel's render-key cache would otherwise keep showing the old footnote text
 * until the next external render trigger. Dynamic import — window.js imports
 * this module statically, so a static back-import would close a cycle (the
 * same pattern launcher.js uses).
 */
function refreshFloatingPanel() {
    import('./ui/window.js')
        .then(({ panelInvalidate, updatePanel }) => {
            panelInvalidate();
            updatePanel();
        })
        .catch(() => { /* best-effort refresh */ });
}

/**
 * Show the footnote popup anchored to a marker.
 *
 * @param {{ index: number, anchor: string, text: string }} fn - the footnote
 * @param {HTMLElement} anchorEl - the marker the popup is positioned against
 * @param {{ msgId?: string, swipeIdx?: number, fp?: string } | null} [ctx]
 *        Cache context for Edit/Delete. When null/absent (e.g. a manual call),
 *        only Copy is offered.
 */
export function showPopup(fn, anchorEl, ctx = null) {
    const shouldToggle = _currentPopup && _popupAnchor === anchorEl;
    closePopup();
    if (shouldToggle) return;

    const popup = document.createElement('div');
    popup.className = 'gls-popup';
    popup.setAttribute('role', 'dialog');

    const body = document.createElement('div');
    body.className = 'gls-popup-body';
    // Dictionary layout: the headword split from the raw text ("Term
    // (source)") becomes the title row, prefixed with the footnote index;
    // the body starts at the definition proper. When the text has no
    // headword separator the anchored term stands in as the title (if any),
    // and the full text stays the body either way.
    // Strip the model-authored superscript first. `fn.index` is the canonical
    // structural number (it survives renumbering and is rendered separately in
    // the title); keeping both produced titles such as `7⁷ Крестовский остров`.
    const displayText = stripLeadingNumber(fn.text).trim();
    const split = splitFootnoteHead(displayText);
    const title = split?.head || fn?.anchor || '';
    if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'gls-popup-title';
        if (fn.index != null) {
            const idx = document.createElement('sup');
            idx.className = 'gls-popup-title-idx';
            idx.textContent = fn.index;
            titleEl.appendChild(idx);
        }
        const titleText = document.createElement('span');
        titleText.className = 'gls-popup-title-text';
        titleText.innerHTML = formatFootnoteText(title);
        titleEl.appendChild(titleText);
        body.appendChild(titleEl);
    }
    const textEl = document.createElement('p');
    textEl.className = 'gls-popup-text';
    textEl.innerHTML = formatFootnoteText(split ? split.body : displayText);
    body.appendChild(textEl);

    // Header (Copy/Edit/Delete/Close) is optional: with popupShowHeader off the
    // popup is pure reading surface. Closing still works - Escape, outside
    // click, or clicking the same marker toggles it - and Copy/Edit/Delete
    // remain available on the floating panel's rows.
    if (S().popupShowHeader) {
        const header = document.createElement('div');
        header.className = 'gls-popup-header';

        // Close button always present in the header. Copy/Edit/Delete are built via
        // the shared action module so the popup and the floating panel behave
        // identically; Edit/Delete require a cache context (msgId/swipeIdx/fp).
        const closeBtn = document.createElement('button');
        closeBtn.className = 'gls-popup-close';
        closeBtn.innerHTML = iconHtml('xmark', { size: 14 });
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', closePopup);

        const hasContext = ctx && ctx.msgId != null;
        if (hasContext) {
            const buttons = buildFootnoteActions({
                fn,
                msgId: ctx.msgId,
                swipeIdx: ctx.swipeIdx ?? 0,
                digest: ctx.digest,
                kind: ctx.kind === 't' ? 't' : 'fn',
                variant: 'popup',
                editHost: body,
                // The popup tracks its own editing flag so Escape doesn't yank the
                // whole popup while the textarea is focused.
                validateContext: () => _currentPopup === popup,
                // The popup is the presenter for highlight refresh: after a delete
                // it re-injects the merged survivors - read fresh from the store so
                // both kinds survive - or strips highlights when the payload was
                // emptied.
                onRefreshHighlights: (_footnotes, msgId) => {
                    const mesEl = document.querySelector(`.mes[mesid="${msgId}"]`);
                    if (!mesEl) return;
                    removeHighlights(mesEl);
                    const swipe = getCtx().chat?.[parseInt(msgId)]?.swipe_id ?? 0;
                    const merged = getVariantFootnotes(msgId, swipe);
                    if (merged?.length) injectHighlights(mesEl, merged);
                },
                onAfterEdit: () => {
                    _popupEditing = false;
                    // The edit mutated the payload; refresh the underlying message's
                    // highlights so the popup-text change is reflected inline too.
                    const mesEl = document.querySelector(`.mes[mesid="${ctx.msgId}"]`);
                    if (mesEl) {
                        removeHighlights(mesEl);
                        const footnotes = getVariantFootnotes(ctx.msgId, ctx.swipeIdx ?? 0);
                        if (footnotes?.length) injectHighlights(mesEl, footnotes);
                    }
                    closePopup();
                    // An open floating panel still shows the pre-edit text —
                    // its render-key cache only refreshes on a render call.
                    refreshFloatingPanel();
                },
                onAfterDelete: () => {
                    _popupEditing = false;
                    closePopup();
                    refreshFloatingPanel();
                },
            });
            // Reflect editing state for Escape handling. The shared editor doesn't
            // know about this popup-local flag, so we watch DOM mutations on body.
            const mo = new MutationObserver(() => {
                _popupEditing = body.querySelector('.gls-panel-edit-input') != null;
            });
            mo.observe(body, { childList: true, subtree: true });
            popup._glsEditObserver = mo;
            header.append(buttons.copy, buttons.edit, buttons.del);
        } else {
            // No cache context: offer Copy only, with inline "Copied ✓" feedback.
            const copyOnly = buildFootnoteActions({
                fn,
                msgId: '', swipeIdx: 0, digest: '',
                variant: 'popup',
                editHost: body,
                validateContext: () => false,
                onAfterEdit: () => {},
                onAfterDelete: () => {},
            });
            header.append(copyOnly.copy);
        }
        header.appendChild(closeBtn);
        popup.appendChild(header);
    }
    popup.appendChild(body);
    document.body.appendChild(popup);
    positionPopup(popup, anchorEl);

    _currentPopup = popup;
    _popupAnchor = anchorEl;

    // Follow the anchor while open: chat scrolls / window resizes re-anchor
    // the popup (rAF-coalesced, below), and it closes once the marker left
    // the viewport so it can't linger clamped to an edge, detached from its
    // anchor. Without this, position:fixed + a one-shot position left the
    // popup floating over unrelated text after any scroll — glaring on
    // mobile, where the chat is scrolled constantly.
    document.addEventListener('scroll', onPopupViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onPopupViewportChange, { passive: true });

    // Defer outside-listener registration so the opening click itself doesn't
    // immediately close the popup. The timer is owned on the popup instance so
    // a closePopup() during the delay window (and teardown) cancels it instead
    // of registering listeners on an already-removed popup.
    _popupOpenTimer = setTimeout(() => {
        _popupOpenTimer = null;
        if (_currentPopup !== popup) return; // closed or replaced during the tick
        document.addEventListener('pointerdown', onOutsidePopup, true);
        document.addEventListener('click', onOutsidePopup, true);
        document.addEventListener('keydown', onPopupKeydown, true);
    }, 0);
}

/**
 * Place the popup against its anchor marker.
 *
 * Vertical: the preferred side comes from the popupPosition setting -
 * 'auto' picks whichever side has more free viewport space, 'below'/'above'
 * pin the side. Whatever the preference, the chosen side must FIT: when it
 * lacks room the popup flips to the opposite side, and when neither fits it
 * clamps into the viewport (top edge at the margin) so the popup is never
 * pushed off-screen. On very short viewports (popup taller than the space
 * both sides can offer) the clamped position still leaves the popup
 * scrollable - .gls-popup has overflow-y auto and max-height 70vh.
 *
 * Horizontal: aligned to the marker's left edge, nudged to keep the popup
 * inside the viewport.
 *
 * Pure arithmetic over (rect, popupSize, viewport) except the final style
 * write; exported for unit tests.
 *
 * @param {HTMLElement} popup
 * @param {HTMLElement} anchorEl
 * @returns {{ left: number, top: number }} the applied position.
 */
export function positionPopup(popup, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const popW = popup.offsetWidth || 320;
    const popH = popup.offsetHeight || 160;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 10;
    const gap = 6;

    // ── Vertical: pick side from preference, flip when it can't fit ──
    const spaceBelow = vh - rect.bottom - margin;   // room under the marker
    const spaceAbove = rect.top - margin;           // room over the marker
    const preference = S().popupPosition || 'auto';
    let placeBelow;
    if (preference === 'above') placeBelow = false;
    else if (preference === 'below') placeBelow = true;
    else placeBelow = spaceBelow >= spaceAbove;     // auto: roomier side wins

    // Flip when the preferred side can't host the popup AND the other side
    // offers strictly more room. When both sides are equally cramped the
    // popup stays on the preferred side and clamps (predictable behavior on
    // tiny viewports instead of oscillating).
    if (placeBelow && popH > spaceBelow && spaceAbove > spaceBelow) placeBelow = false;
    else if (!placeBelow && popH > spaceAbove && spaceBelow > spaceAbove) placeBelow = true;

    let top;
    if (placeBelow) {
        top = rect.bottom + gap;
        if (top + popH > vh - margin) top = vh - margin - popH;   // clamp into view
    } else {
        top = rect.top - popH - gap;
        if (top < margin) top = margin;
    }
    // Last-resort clamp for neither-side-fits (top may still be < margin).
    if (top < margin) top = margin;

    // ── Horizontal: marker-aligned, viewport-bounded ──
    let left = rect.left;
    if (left + popW > vw - margin) left = vw - margin - popW;
    if (left < margin) left = margin;

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    return { left, top };
}

export function closePopup() {
    if (_popupOpenTimer) { clearTimeout(_popupOpenTimer); _popupOpenTimer = null; }
    if (_popupFollowRaf) { cancelAnimationFrame(_popupFollowRaf); _popupFollowRaf = 0; }
    document.removeEventListener('scroll', onPopupViewportChange, { capture: true });
    window.removeEventListener('resize', onPopupViewportChange);
    if (_currentPopup?._glsEditObserver) {
        _currentPopup._glsEditObserver.disconnect();
        delete _currentPopup._glsEditObserver;
    }
    if (_currentPopup) { _currentPopup.remove(); _currentPopup = null; }
    _popupAnchor = null;
    _popupEditing = false;
    document.removeEventListener('pointerdown', onOutsidePopup, true);
    document.removeEventListener('click', onOutsidePopup, true);
    document.removeEventListener('keydown', onPopupKeydown, true);
}

function onOutsidePopup(e) {
    if (!_currentPopup) return;
    if (_currentPopup.contains(e.target)) return;
    if (_popupAnchor && _popupAnchor.contains?.(e.target)) return;
    closePopup();
}

/**
 * Viewport-change pump for the open popup. Capture-phase scroll catches every
 * scrollable ancestor (scroll doesn't bubble) — #chat, inner panels — while
 * scrolls ORIGINATING inside the popup body (max-height 70vh, overflow-y
 * auto) are ignored so reading a long footnote never moves it. Work is
 * coalesced into one rAF; inside the frame the popup either re-anchors via
 * positionPopup or closes when its marker scrolled out of view / was removed.
 */
/**
 * Popup auto-close gate for the follow pump. Pure.
 *
 * The anchor is gone when its rect left the viewport on any edge — or when it
 * collapsed to a ZERO-AREA rect: a connected marker inside a hidden message
 * (e.g. Message Collapser sets display:none on .mes_text) reports 0×0 at the
 * viewport corner, which the plain bounds check read as "in view" and kept
 * the popup open forever over collapsed content.
 * @param {{ top: number, bottom: number, left: number, right: number, width: number, height: number }} rect
 * @param {number} vw viewport width
 * @param {number} vh viewport height
 * @returns {boolean}
 */
export function isAnchorGone(rect, vw, vh) {
    if (rect.width === 0 && rect.height === 0) return true;
    return rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw;
}

function onPopupViewportChange(e) {
    if (!_currentPopup) return;
    if (e.type === 'scroll' && e.target instanceof Element && _currentPopup.contains(e.target)) return;
    if (_popupFollowRaf) return;
    _popupFollowRaf = requestAnimationFrame(() => {
        _popupFollowRaf = 0;
        if (!_currentPopup || !_popupAnchor) return;
        if (!_popupAnchor.isConnected) { closePopup(); return; }
        const rect = _popupAnchor.getBoundingClientRect();
        if (isAnchorGone(rect, window.innerWidth, window.innerHeight)) {
            closePopup();
            return;
        }
        positionPopup(_currentPopup, _popupAnchor);
    });
}

function onPopupKeydown(e) {
    if (e.key !== 'Escape') return;
    // While the inline editor is mounted, Escape should cancel the edit (by
    // blurring / triggering Cancel) rather than discarding the whole popup.
    if (_popupEditing) return;
    closePopup();
}
