// @ts-check
/**
 * Glosses — Footnote popup (reading view anchored to a marker).
 *
 * Extracted verbatim from renderer.js's FOOTNOTE POPUP section (R-7.3 module
 * split): the popup element, positioning/follow/clamp, outside-click and
 * Escape handling. renderer.js reaches showPopup through a DYNAMIC import
 * (activateMarker) — this module statically imports renderer's reinjectInto,
 * the same lazy-import pattern the codebase uses to keep module-eval acyclic.
 */

import { S, getCtx, t } from '../core.js';
import { stripLeadingNumber } from '../parser.js';
import { reinjectInto } from '../renderer.js';
import { formatFootnoteText, splitFootnoteHead } from '../footnote-format.js';
import { buildPopupHeader } from './popup-header.js';
import { buildFootnoteActions } from './footnote-actions.js';

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
 * (Re)render the footnote reading view into the popup body.
 *
 * Dictionary layout: the headword split from the raw text ("Term
 * (source)") becomes the title row, prefixed with the footnote index;
 * the body starts at the definition proper. When the text has no
 * headword separator the anchored term stands in as the title (if any),
 * and the full text stays the body either way.
 * Strip the model-authored superscript first. `fn.index` is the canonical
 * structural number (it survives renumbering and is rendered separately in
 * the title); keeping both produced titles such as `7⁷ Крестовский остров`.
 *
 * Extracted from showPopup so the EDIT-CANCEL path can restore the reading
 * view: the inline editor replaces the body's contents wholesale, and a bare
 * cancel must return the popup to the footnote instead of closing it (the
 * shared action bar used to map cancel and save onto the same close-down
 * callback — UX fix).
 */
function renderPopupBodyView(body, fn) {
    body.innerHTML = '';
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
    renderPopupBodyView(body, fn);

    // Header (Copy/Edit/Delete/Close) is optional: with popupShowHeader off the
    // popup is pure reading surface. Closing still works - Escape, outside
    // click, or clicking the same marker toggles it - and Copy/Edit/Delete
    // remain available on the floating panel's rows.
    if (S().popupShowHeader) {
        // Header structure (actions group + ✕) comes from the shared builder —
        // the same one that paints the settings/twin previews, so the three
        // copies can't drift again. Only the behavior-bearing buttons are
        // wired here, via buildFootnoteActions. Copy/Edit/Delete require a
        // cache context (msgId/swipeIdx/fp). The action buttons live in their
        // own left-side group (.gls-popup-actions) so the header can pin the
        // ✕ to the right edge at any width.
        const { header, actions: actionsGroup, close: builderClose } = buildPopupHeader({
            onClose: closePopup,
        });

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
                    const swipe = getCtx().chat?.[parseInt(msgId)]?.swipe_id ?? 0;
                    reinjectInto(msgId, swipe);
                },
                onAfterEdit: () => {
                    _popupEditing = false;
                    // The edit mutated the payload; refresh the underlying
                    // message's highlights so the popup-text change is
                    // reflected inline too.
                    reinjectInto(ctx.msgId, ctx.swipeIdx ?? 0);
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
                // Bare cancel (or Escape in the editor): discard the draft but
                // STAY open — restore the reading view and re-anchor to wherever
                // the viewport currently is (the keyboard may have been up).
                // Closing here was the old behavior and read as data loss.
                onEditCancelled: () => {
                    _popupEditing = false;
                    renderPopupBodyView(body, fn);
                    if (_popupAnchor?.isConnected) positionPopup(popup, _popupAnchor);
                },
                // The editing flag drives Escape/freeze handling; set by the
                // action bar when the editor mounts, cleared by the three exit
                // callbacks (saved/cancelled/deleted) and by closePopup().
                onEditStarted: () => { _popupEditing = true; },
            });
            actionsGroup.append(buttons.copy, buttons.edit, buttons.del);
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
            actionsGroup.append(copyOnly.copy);
        }
        header.appendChild(actionsGroup);
        header.appendChild(builderClose);
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
    // Mobile keyboards change the VISIBLE band without a layout resize on iOS
    // (visualViewport shrinks/pans inside the layout viewport) — follow it so
    // the popup/edit can be clamped into what the user can actually see.
    getVisualViewport()?.addEventListener('resize', onPopupViewportChange, { passive: true });
    getVisualViewport()?.addEventListener('scroll', onPopupViewportChange, { passive: true });

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
    getVisualViewport()?.removeEventListener('resize', onPopupViewportChange);
    getVisualViewport()?.removeEventListener('scroll', onPopupViewportChange);
    if (_currentPopup) { _currentPopup.remove(); _currentPopup = null; }
    _popupAnchor = null;
    _popupEditing = false;
    document.removeEventListener('pointerdown', onOutsidePopup, true);
    document.removeEventListener('click', onOutsidePopup, true);
    document.removeEventListener('keydown', onPopupKeydown, true);
}

let _lastOutsideGesture = 0;
function onOutsidePopup(e) {
    if (!_currentPopup) return;
    if (_currentPopup.contains(e.target)) return;
    if (_popupAnchor && _popupAnchor.contains?.(e.target)) return;
    // pointerdown and click both register the same outside gesture (the
    // listeners are registered for both); act once per gesture, or the
    // click trailing a pointerdown that just cancelled the edit would close
    // the popup in the same gesture.
    if (e.timeStamp - _lastOutsideGesture < 500) return;
    _lastOutsideGesture = e.timeStamp;
    // Outside click while the editor is open reads as "bare cancel", not
    // "close": route it through the editor's own Cancel (same contract as
    // Escape — draft discarded, reading view restored, popup stays open) so
    // a stray click cannot silently destroy typed text. The next outside
    // click, with editing off, closes normally.
    if (_popupEditing) {
        _currentPopup.querySelector('.gls-edit-cancel')?.click();
        return;
    }
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
    // Dead anchor is terminal in ANY mode: the message was deleted / swiped
    // away under the popup. Synchronous + cheap, so it runs even while the
    // editor freezes follow — otherwise deletion during an edit leaves a
    // zombie popup with a live editor over empty space.
    if (_popupAnchor && !_popupAnchor.isConnected) { closePopup(); return; }
    // While the inline editor is mounted, FREEZE follow + auto-close. Opening
    // the mobile keyboard fires resize/scroll; the visual viewport then pans
    // and the anchor can read as "gone" by rect (popup snaps shut mid-edit)
    // or the popup gets re-anchored somewhere behind the keyboard. The edit
    // is modal in practice — re-anchoring resumes once it's saved/cancelled.
    // EXCEPTION: resizes (layout shrink on Android, visual-viewport shrink on
    // iOS) must keep the popup itself in the VISIBLE band — position:fixed
    // otherwise leaves it parked under the keyboard line, editor unreachable.
    if (_popupEditing) {
        if (e.type === 'resize') requestPopupEditingClamp();
        return;
    }
    if (_popupFollowRaf) return;
    _popupFollowRaf = requestAnimationFrame(() => {
        _popupFollowRaf = 0;
        if (!_currentPopup || !_popupAnchor) return;
        if (!_popupAnchor.isConnected) { closePopup(); return; }
        // Re-check after the frame: the editor may have mounted in between.
        if (_popupEditing) return;
        const rect = _popupAnchor.getBoundingClientRect();
        if (isAnchorGone(rect, window.innerWidth, window.innerHeight)) {
            closePopup();
            return;
        }
        positionPopup(_currentPopup, _popupAnchor);
    });
}

// visualViewport is universal in current browsers, but read it lazily (never at
// module eval) — the unit-test DOM stub provides a minimal window.
function getVisualViewport() {
    try { return window.visualViewport ?? null; } catch { return null; }
}

/** Coalesce editing clamps through the same rAF ticket as the follow pump. */
function requestPopupEditingClamp() {
    if (_popupFollowRaf) return;
    _popupFollowRaf = requestAnimationFrame(() => {
        _popupFollowRaf = 0;
        if (!_currentPopup) return;
        clampPopupIntoViewport(_currentPopup);
    });
}

/**
 * Pure core of the editing clamp (unit-tested): clamp a position:fixed popup
 * rectangle into the VISIBLE band of the viewport. `bandTop`/`bandHeight`
 * describe that band in layout-viewport coordinates — equal to the whole
 * viewport when the keyboard shrinks the layout viewport (Android), and to
 * visualViewport.offsetTop/.height when it only shrinks the visual viewport
 * (iOS). A popup taller than the band pins to the band's top edge and scrolls
 * internally (.gls-popup has overflow-y + max-height). Returns {left, top}.
 */
export function clampPopupPosition(pos, popW, popH, vw, bandTop, bandHeight, margin = 10) {
    const bandBottom = bandTop + bandHeight;
    let top = pos.top;
    if (popH >= bandHeight - margin * 2) {
        top = bandTop + margin;
    } else if (top + popH > bandBottom - margin) {
        top = bandBottom - margin - popH;
    }
    if (top < bandTop + margin) top = bandTop + margin;
    let left = pos.left;
    if (left + popW > vw - margin) left = vw - margin - popW;
    if (left < margin) left = margin;
    return { left, top };
}

/**
 * Clamp the live popup into the currently visible viewport band (see
 * clampPopupPosition). Applied while the inline editor is mounted and the
 * viewport resizes — the keyboard case — so the editor stays reachable.
 * @returns {{left: number, top: number}} the applied position.
 */
export function clampPopupIntoViewport(popup) {
    const vv = getVisualViewport();
    const bandTop = vv ? vv.offsetTop : 0;
    const bandHeight = vv ? vv.height : window.innerHeight;
    const current = {
        left: parseFloat(popup.style.left) || 0,
        top: parseFloat(popup.style.top) || 0,
    };
    const pos = clampPopupPosition(
        current,
        popup.offsetWidth || 320,
        popup.offsetHeight || 160,
        window.innerWidth,
        bandTop,
        bandHeight,
    );
    popup.style.left = `${pos.left}px`;
    popup.style.top = `${pos.top}px`;
    return pos;
}

function onPopupKeydown(e) {
    if (e.key !== 'Escape') return;
    // While the inline editor is mounted, Escape should cancel the edit rather
    // than discarding the whole popup. The editor's keydown is scoped to its
    // textarea, so with focus anywhere else (header buttons, popup body) the
    // key used to die completely — delegate to the editor's Cancel button.
    // This handler is document-level CAPTURE, so it fires before the
    // textarea's own keydown; skip the textarea case or the edit would cancel
    // twice.
    if (_popupEditing) {
        if (!(e.target instanceof HTMLTextAreaElement)) {
            _currentPopup?.querySelector('.gls-edit-cancel')?.click();
        }
        return;
    }
    closePopup();
}
