// @ts-check
/**
 * Glosses — Renderer module
 * DOM highlighting (anchor wrapping), footnote popup, regenerate button, spinner.
 *
 * Ported 1:1 from SillyTavern-Footnotes. The anchor-walking TreeWalker, the
 * pointerup/click touch-toggle trick, and the popup positioning all stay as-is.
 */

import { state, S, getCtx, t, warn } from './core.js';
import { formatFootnoteText } from './footnote-format.js';
import { generationCoordinator } from './application/generation-coordinator.js';
import { getVariantFootnotes, getVariantPayload } from './cache.js';
import { targetedOf } from './domain/footnote-payload.js';
import { isTranslatedView } from './domain/message-identity.js';
import { indexToSuperscript, indexToTargetedSymbol, stripLeadingNumber } from './parser.js';
import { findAllAnchorSpans, normalizeAnchorKey } from './anchor-utils.js';
import { buildTextIndex, segmentsFor } from './text-index.js';
import { rankOccurrencesByContext } from './domain/rebind.js';

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
    // displayMode 'panel': no markers / inline block at all — footnotes live
    // only in the floating panel. removeHighlights above still runs so a mode
    // switch strips already-rendered markers via reapplyHighlightsAll.
    if (S().displayMode === 'panel') return;
    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText || !footnotes?.length) return;

    // Floating entries (anchor absent from the post) still render in the
    // inline block/panel, but wrapAnchors would re-warn "not found" for them
    // on every render — exclude them from wrapping up front.
    const withAnchor = footnotes.filter(f => f.anchor?.trim() && !f.floating);
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
 * Place every footnote's marker against the message's text INDEX (one
 * concatenated string over the DOM's text nodes) instead of per-text-node
 * matching. An anchor crossing an inline-element boundary (<em>, <code>, …)
 * now yields a multi-piece marker — one .gls-marker span per crossed node —
 * where the old per-node walker silently dropped it.
 *
 * Placement: the stored prefix/suffix context ranking decides WHICH
 * occurrence represents each footnote (the one the anchor was originally
 * placed on), then a greedy pass in best-occurrence document order resolves
 * overlaps — per footnote the first ranked occurrence that does not overlap
 * an already-claimed span wins (the same contract the rebind path applies;
 * claiming is per footnote, so two footnotes on different occurrences of the
 * same word each get their own span). Returns a report so footnotes that end
 * up without a marker are observable instead of silent.
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

    const claimOrder = [...perFn].sort((a, b) =>
        (a.occurrences[0]?.start ?? Infinity) - (b.occurrences[0]?.start ?? Infinity));
    const claimed = [];
    const placed = new Map(); // fn → winning span
    for (const p of claimOrder) {
        const span = p.occurrences.find(o => !claimed.some(c => o.start < c.end && c.start < o.end));
        if (!span) continue;
        claimed.push(span);
        placed.set(p.fn, span);
    }

    // Materialize right-to-left: splitting a node keeps its head in the
    // original node reference, so segments of spans further left (processed
    // later) keep valid (node, offset) pairs.
    const order = [...placed.entries()].sort((a, b) => b[1].start - a[1].start);
    for (const [fn, span] of order) {
        const segments = segmentsFor(index, span.start, span.end);
        // Superscript rides the LAST piece: ST's markdown wraps «…» / "…"
        // quotes in <q>, splitting the anchor's text nodes mid-phrase, and a
        // sup on the first piece would land before the quoted term.
        const primaryIdx = segments.length - 1;
        segments.forEach((seg, i) => wrapSegment(seg, fn, i === primaryIdx, i, segments.length));
    }

    report.placed = placed.size;
    report.unmatched = perFn
        .filter(p => !placed.has(p.fn))
        .map(p => ({ index: p.fn.index, anchor: p.fn.anchor, reason: p.occurrences.length ? 'overlap' : 'not found' }));
    if (report.unmatched.length) warn('Footnotes without markers:', report.unmatched);
    return report;
}

/**
 * Which edges of a multi-piece marker sit at a seam (an element boundary
 * ST's markdown inserted — most often <q> around quoted text). The CSS zeroes
 * the inner-side padding and corner radii on those edges so N adjacent pieces
 * render as ONE continuous highlight band; a single-piece marker keeps its
 * full pill look. Exported for unit tests.
 *
 * @param {number} i - zero-based piece index
 * @param {number} total - total piece count for the anchor
 * @returns {string[]} seam classes to add to the piece
 */
export function markerSeamClasses(i, total) {
    if (!(total > 1)) return [];
    const classes = [];
    if (i < total - 1) classes.push('gls-marker-seam-r');
    if (i > 0) classes.push('gls-marker-seam-l');
    return classes;
}

/**
 * Wrap one segment (a run inside a single text node) of a footnote's span.
 * Splitting isolates the exact run; the run is then replaced by the marker
 * piece. The primary piece (the LAST one — see wrapAnchors) carries the
 * superscript; every earlier piece gets a continuation class (same styling,
 * no superscript) so a phrase crossing element boundaries still reads as one
 * anchor. Seam-side classes flatten the joint edges between pieces (see
 * markerSeamClasses).
 */
function wrapSegment(seg, fn, primary, pieceIndex = 0, pieceTotal = 1) {
    const node = seg.node;
    let target = node;
    if (seg.start > 0) target = node.splitText(seg.start);
    if (seg.end - seg.start < (target.nodeValue ?? '').length) target.splitText(seg.end - seg.start);
    const run = target.nodeValue ?? '';
    const piece = createMarker(fn, run, primary, markerSeamClasses(pieceIndex, pieceTotal));
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
function createMarker(fn, sourceText, primary = true, seamClasses = []) {
    const isTargeted = fn.kind === 't';
    const span = document.createElement('span');
    span.className = 'gls-marker';
    if (!primary) span.classList.add('gls-marker-cont');
    for (const cls of seamClasses) span.classList.add(cls);
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

/** One marker-activation policy for both input paths: popup modes resolve and
 *  show; inline mode reveals the block. */
function activateMarker(marker) {
    if (S().displayMode !== 'inline') {
        const resolved = resolveFootnoteFromMarker(marker);
        // showPopup lives in ui/footnote-popup.js (R-7.3 split); the lazy
        // import keeps renderer ↔ popup module-eval acyclic — the popup
        // module statically imports reinjectInto from here.
        if (resolved) {
            import('./ui/footnote-popup.js')
                .then(({ showPopup }) => showPopup(resolved.fn, marker, resolved))
                .catch(() => { /* popup open is best-effort UI */ });
        }
    } else {
        revealInlineFootnote(marker);
    }
}

function onDelegatedPointerUp(e) {
    // Touch path: fire the popup on pointerup for instant response, then flag
    // the marker so the immediately-following click is suppressed.
    if (e.pointerType === 'mouse') return;
    const marker = e.target.closest?.('.gls-marker');
    if (!marker) return;
    e.stopPropagation();
    marker._glsTouchHandled = true;
    activateMarker(marker);
}

function onDelegatedClick(e) {
    const marker = e.target.closest?.('.gls-marker');
    if (!marker) return;
    e.stopPropagation();
    if (marker._glsTouchHandled) { marker._glsTouchHandled = false; return; }
    activateMarker(marker);
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
 * Swap one message's markers for the merged (regular + targeted) set read
 * fresh from the payload store, or strip them when the store is empty. The
 * one re-injection path for post-mutation refreshes (edit, delete, targeted
 * commit) in renderer, panel and events.
 * @param {string|number} msgId
 * @param {number} swipeIdx
 */
export function reinjectInto(msgId, swipeIdx) {
    const mesEl = document.querySelector(`.mes[mesid="${msgId}"]`);
    if (!mesEl) return;
    removeHighlights(mesEl);
    const merged = getVariantFootnotes(msgId, swipeIdx);
    if (merged?.length) injectHighlights(mesEl, merged);
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
    // displayMode 'panel' renders no markers: skip the cache read + lazy
    // observation entirely (footnotes are shown in the floating panel only).
    if (S().displayMode === 'panel') return;
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
        // `state` comes from the static import above: the old
        // `await import('./core.js')` here deferred the isGenerating check by a
        // microtask, so two clicks in one tick both saw "not generating" and
        // both started runs (the second superseded — a wasted API request).
        if (state.isGenerating[messageId]) {
            // A bare abort() leaves the run "current": a transport that ignores
            // AbortSignal would still pass isCurrent() and commit the
            // "cancelled" generation. bumpMessageRevision aborts AND bumps the
            // revision, so the commit guard fails even then.
            generationCoordinator.bumpMessageRevision(messageId);
            return;
        }
        const swipeIdx = msg.swipe_id ?? 0;
        // Keep the previous highlights until the replacement validates and saves.
        // Dynamic import: generator.js statically imports this module (cycle).
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

