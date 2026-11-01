// @ts-check
/**
 * Glosses — Floating panel layout machinery.
 *
 * Extracted verbatim from window.js (R-7.4 module split): localStorage
 * persistence, rAF-coalesced drag/resize, mobile-sheet mode with ST chrome
 * measurement, and the live mobile↔desktop viewport sync. window.js calls the
 * exported appliers/builders; the drag/resize tails re-sync the FAB
 * passthrough through a lazy floating-launcher import (no window.js cycle).
 */

import { t, PANEL_LAYOUT_KEY, MOBILE_BREAKPOINT, debounce } from '../core.js';
import { whenSendFormReady } from './dom-ready.js';

/** Layout moved — the FAB-over-header passthrough must be re-evaluated. */
function _syncFabAfterLayoutChange() {
    import('./floating-launcher.js')
        .then(({ syncFloatingLauncher }) => syncFloatingLauncher())
        .catch(() => { /* best-effort UI nicety */ });
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYOUT PERSISTENCE (position / size of the panel, in localStorage)
// ══════════════════════════════════════════════════════════════════════════════

function loadPanelLayout() {
    try { return JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || 'null') || {}; } catch { return {}; }
}

function savePanelLayout(patch) {
    const cur = loadPanelLayout();
    try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify({ ...cur, ...patch })); } catch { /* quota */ }
}

export function applyPanelLayout(panel) {
    const layout = loadPanelLayout();
    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    if (!isMobile && layout.left !== undefined && layout.top !== undefined) {
        panel.style.left = `${layout.left}px`;
        panel.style.top = `${layout.top}px`;
        panel.style.right = 'auto';
        panel.style.transform = 'none';
    }
    if (layout.width) panel.style.width = `${layout.width}px`;
    if (layout.height) panel.style.height = `${layout.height}px`;
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    let left = parseInt(panel.style.left) || rect.left;
    let top = parseInt(panel.style.top) || rect.top;
    left = Math.max(0, Math.min(left, window.innerWidth - 60));
    top = Math.max(0, Math.min(top, window.innerHeight - 60));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
// ══════════════════════════════════════════════════════════════════════════════
// MOBILE / VIEWPORT SYNC
// Ported from DS Comments (measureStChrome / initViewportSync). On a narrow
// viewport the panel becomes a fullscreen sheet inset between ST's top chrome
// (#top-bar) and the input bar (#send_form); drag/resize are disabled. A
// resize-listener toggles the mode live so rotating the device or narrowing the
// window reflows the panel instead of leaving it stuck in the desktop --side
// layout (the original bug: isMobile was computed only at buildPanel() time).
// ══════════════════════════════════════════════════════════════════════════════

const ST_TOPBAR_SEL = '#top-bar';
const ST_SENDFORM_SEL = '#send_form';
const ST_TOPBAR_FALLBACK = 40;   // px, only if #top-bar exists but reads ≤0
const ST_SENDFORM_FALLBACK = 120;

export function isMobileViewport() {
    // Width check catches portrait phones + narrow desktop windows.
    if (window.innerWidth < MOBILE_BREAKPOINT) return true;
    // A phone rotated to landscape still has a small screen and a coarse
    // (touch) pointer — innerWidth alone misses it (a landscape phone can be
    // ≥768 CSS px wide). Detect via the short screen side + touch capability.
    // Tablets (short side ≥768) and touch laptops stay in desktop mode.
    const shortSide = Math.min(screen.width || 9999, screen.height || 9999);
    if (navigator.maxTouchPoints > 0 && shortSide < MOBILE_BREAKPOINT) return true;
    return false;
}

/**
 * Measure ST's top bar and input bar and expose them as CSS custom properties on
 * the panel, so the mobile fullscreen rule can inset between them instead of
 * being covered. Mirrors DS Comments measureStChrome(). Safe to call on desktop
 * (cheap) — the values are only read by the .gls-panel--mobile rule.
 */
export function measureStChrome(panel) {
    let topH = 0;
    const topBar = document.querySelector(ST_TOPBAR_SEL);
    if (topBar) {
        const r = topBar.getBoundingClientRect();
        topH = r.bottom > 0 ? Math.min(r.bottom, window.innerHeight) : ST_TOPBAR_FALLBACK;
    }
    let bottomH = 0;
    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    if (sendForm) {
        const r = sendForm.getBoundingClientRect();
        bottomH = Math.max(0, Math.min(r.height, window.innerHeight)) || ST_SENDFORM_FALLBACK;
    }
    // Defensive caps: on some ST mobile layouts #send_form wraps more than the
    // input bar (or #top-bar is a tall container). Unbounded insets would make
    // height: calc(100dvh - top - bottom) go to 0 and hide the panel. The input
    // bar is never >50% of the viewport, the top bar never >40%.
    topH = Math.min(topH, Math.round(window.innerHeight * 0.4));
    bottomH = Math.min(bottomH, Math.round(window.innerHeight * 0.5));
    panel.style.setProperty('--gls-st-top', `${topH}px`);
    panel.style.setProperty('--gls-st-bottom', `${bottomH}px`);
}

/** Switch the panel to the fullscreen mobile sheet. Clears inline geometry so
 *  the CSS .gls-panel--mobile rules take over, then re-measures ST chrome. */
export function applyMobileMode(panel) {
    panel.classList.add('gls-panel--mobile');
    panel.classList.remove('gls-panel--side');
    // Clear inline geometry so CSS fullscreen rules apply unimpeded.
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.transform = '';
    measureStChrome(panel);
}

/** Switch back to the desktop side panel: restore the persisted layout and
 *  clamp inside the viewport. */
export function applyDesktopMode(panel) {
    panel.classList.remove('gls-panel--mobile');
    panel.classList.add('gls-panel--side');
    applyPanelLayout(panel);
    if (panel.style.left !== '' || panel.style.top !== '') clampPanel(panel);
}

let _viewportBound = false;
let _viewportHandler = null;
let _chromeResizeObserver = null;
// Disposer for the pending APP_READY subscription (when #send_form wasn't
// mounted yet at attach time) — disconnectViewportSync MUST invoke it, or a
// disable before APP_READY lets the late event attach an orphaned observer.
let _viewportReadyDispose = null;

/**
 * Bind a debounced resize listener that toggles the panel between desktop and
 * mobile fullscreen layouts. Idempotent. Also watches #send_form with a
 * ResizeObserver so the mobile bottom inset tracks QR-bar expand/collapse.
 * Call disconnectViewportSync() from cleanup().
 */
export function initViewportSync() {
    if (_viewportBound) return;
    _viewportBound = true;
    _viewportHandler = debounce(() => {
        const panel = _floatingPanel;
        if (!panel || panel.style.display === 'none') return;
        if (isMobileViewport()) {
            applyMobileMode(panel);
        } else {
            applyDesktopMode(panel);
        }
    }, 200);
    window.addEventListener('resize', _viewportHandler);
    // #send_form's height changes at runtime (QR panel expand/collapse, extension
    // toolbar). Track it so the mobile bottom inset stays correct without a
    // window resize. #send_form is lazy-mounted by ST: when it isn't in the DOM
    // yet, wait on APP_READY (whenSendFormReady — event-driven, no deadline)
    // instead of a setInterval probe. The disposer is module-owned so
    // disconnectViewportSync can cancel the pending subscription.
    if (typeof ResizeObserver !== 'undefined') {
        const attachChromeObserver = (sendForm) => {
            _chromeResizeObserver = new ResizeObserver(() => {
                if (_floatingPanel && isMobileViewport()) measureStChrome(_floatingPanel);
            });
            _chromeResizeObserver.observe(sendForm);
        };
        const sendForm = document.querySelector(ST_SENDFORM_SEL);
        if (sendForm) {
            attachChromeObserver(sendForm);
        } else {
            _viewportReadyDispose = whenSendFormReady(attachChromeObserver, {
                onGiveUp: () => { _viewportReadyDispose = null; },
            });
        }
    }
}

export function disconnectViewportSync() {
    _viewportHandler?.cancel();
    if (_viewportBound && _viewportHandler) {
        window.removeEventListener('resize', _viewportHandler);
        _viewportHandler = null;
    }
    _viewportBound = false;
    if (_chromeResizeObserver) { _chromeResizeObserver.disconnect(); _chromeResizeObserver = null; }
    if (_viewportReadyDispose) { _viewportReadyDispose(); _viewportReadyDispose = null; }
}
/**
 * rAF-coalesced drag. Style writes are batched into a single
 * requestAnimationFrame per pointer-event burst, so the browser paints the
 * panel at most once per frame instead of once per mousemove (which caused
 * layout-thrash on the original implementation). Touch + mouse share one path.
 *
 * The dead zone (4px) and clamp behaviour are preserved, and the pending frame
 * is flushed synchronously on pointerup so the panel lands exactly at the
 * release point.
 *
 * On teardown, destroyPanel() calls _abortDragResize() so an in-flight drag
 * does not leave mousemove/mouseup listeners on document.
 */
let _abortDragResize = null;

export function makeDraggable(panel, handle) {
    let startX, startY, startLeft, startTop, isDragging = false, hasMoved = false;
    let pendingFrame = 0;
    let nextLeft = 0, nextTop = 0;

    const flush = () => {
        pendingFrame = 0;
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
    };

    const onDown = (e) => {
        if (isMobileViewport()) return;
        if (e.target.closest('button, .gls-panel-btn, .gls-panel-nav-btn')) return;
        isDragging = true; hasMoved = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const rect = panel.getBoundingClientRect();
        startX = clientX; startY = clientY;
        startLeft = rect.left; startTop = rect.top;
        nextLeft = startLeft; nextTop = startTop;
        panel.style.willChange = 'left, top';
        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        // The OS can cancel the gesture mid-drag (edge swipe, notification
        // shade) — without this the drag stays "in flight" and the document
        // listeners leak until the next touch anywhere.
        document.addEventListener('touchcancel', onUp);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = cx - startX, dy = cy - startY;
        // Dead zone so a click on the header (without drag) doesn't move the panel.
        if (!hasMoved && Math.hypot(dx, dy) < 4) return;
        hasMoved = true;
        e.preventDefault();
        if (!panel.style.left || panel.style.left === 'auto') {
            panel.style.left = `${startLeft}px`;
            panel.style.top = `${startTop}px`;
            panel.style.right = 'auto';
            panel.style.transform = 'none';
        }
        nextLeft = startLeft + dx;
        nextTop = startTop + dy;
        // Coalesce: at most one style write per frame.
        if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
    };

    const onUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        // Flush any pending frame synchronously so the panel lands at the
        // exact release point, then clear the will-change hint.
        if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        flush();
        panel.style.willChange = '';
        if (!hasMoved) return;
        e.stopPropagation?.();
        clampPanel(panel);
        savePanelLayout({ left: parseInt(panel.style.left), top: parseInt(panel.style.top) });
        // The panel moved — the FAB-over-header passthrough must be re-evaluated
        // (syncFabPassthrough otherwise only fires on panel toggles/resizes).
        _syncFabAfterLayoutChange();
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });

    // Allow destroyPanel() to release an in-flight drag without a real pointer
    // event. onUp is no-op when !isDragging, so this is safe to call anytime.
    _abortDragResize = (syntheticEvent) => {
        if (isDragging) onUp(syntheticEvent);
        else if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    };
}

/**
 * rAF-coalesced resize via a bottom-right grip. Width/height are persisted
 * (debounced) into PANEL_LAYOUT_KEY. Same one-write-per-frame pattern as drag.
 * Disabled on mobile (the panel is a bottom-sheet there) and when collapsed.
 */
export function makeResizable(panel) {
    const grip = document.createElement('div');
    grip.className = 'gls-panel-resize';
    grip.title = t('Resize');
    panel.appendChild(grip);

    let isResizing = false, startX, startY, startW, startH;
    let pendingFrame = 0, nextW = 0, nextH = 0;

    const flush = () => {
        pendingFrame = 0;
        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
    };

    const saveSoon = debounce(() => savePanelLayout({ width: panel.offsetWidth, height: panel.offsetHeight }), 300);

    const onMove = (e) => {
        if (!isResizing) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        nextW = Math.max(220, startW + (cx - startX));
        nextH = Math.max(120, startH + (cy - startY));
        e.preventDefault();
        if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
    };

    const onUp = () => {
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        flush();
        panel.style.willChange = '';
        saveSoon();
        // The panel changed size — re-evaluate the FAB-over-header passthrough.
        _syncFabAfterLayoutChange();
    };

    const onDown = (e) => {
        if (isMobileViewport()) return;
        isResizing = true;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        startX = cx; startY = cy;
        const rect = panel.getBoundingClientRect();
        startW = rect.width; startH = rect.height;
        nextW = startW; nextH = startH;
        panel.style.willChange = 'width, height';
        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        // See makeDraggable: a cancelled gesture must release the resize.
        document.addEventListener('touchcancel', onUp);
        e.preventDefault();
        e.stopPropagation();
    };

    grip.addEventListener('mousedown', onDown);
    grip.addEventListener('touchstart', onDown, { passive: false });

    // Layered onto _abortDragResize: abort resize too, plus clear the save
    // debounce timer. destroyPanel() clears _abortDragResize after invoking it.
    const prevAbort = _abortDragResize;
    _abortDragResize = (syntheticEvent) => {
        if (isResizing) onUp(syntheticEvent);
        else if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        saveSoon.cancel();
        prevAbort?.(syntheticEvent);
    };
}

/**
 * Teardown handle for window.destroyPanel(): abort any in-flight drag/resize
 * so document listeners don't outlive the panel. No-op when nothing is in
 * flight; the layered handlers from makeDraggable/makeResizable both run.
 */
export function abortDragResize(syntheticEvent) {
    _abortDragResize?.(syntheticEvent);
}
