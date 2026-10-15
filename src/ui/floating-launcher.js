// @ts-check
/**
 * Glosses — UI: Floating launcher button (FAB)
 * Draggable round button pinned to a viewport corner that toggles the footnotes
 * panel. Selected via settings.launcherMode ('floating' | 'both'). Unlike the
 * quick-reply bar launcher it works even when the QR bar is absent (Quick
 * Replies extension disabled).
 *
 * The FAB never hides while the panel is open — it is the toggle, accent-
 * highlighted via .gls_fab_active (the ✕ on the panel hides, the FAB toggles;
 * both share the toggleLauncherPanel() semantics of the bar launcher).
 *
 * Layering (locked in tests/floating-launcher.test.mjs): z-index 2999 — above
 * the floating panel (2998), below ST's own chrome (left-nav drawer 3000, top
 * bar 3005) so it never blocks host settings. Because the top bar paints over
 * the FAB, drag/restore/resize clamp the position below it: a FAB parked in the
 * top strip would otherwise slide underneath the bar and become permanently
 * unclickable.
 *
 * DOM id: #gls_fab (single source of truth; the same id is asserted by the
 * z-index contract test in tests/floating-launcher.test.mjs; generator.js
 * pulses it with .gls_generating alongside #gls_launcher).
 *
 * Position persists in localStorage (gls_fab_position) as {left, top} px,
 * written only on drag release and restored (validated) on every mount — it
 * survives browser restarts until the user drags the button somewhere else.
 *
 * Ported from DS Comments/src/ui/floating-launcher.js (dsc→gls).
 */

import { DISPLAY_NAME, t, MOBILE_BREAKPOINT } from '../core.js';
import { panelIsVisible } from './window.js';

const FAB_ID = 'gls_fab';
const POSITION_KEY = 'gls_fab_position';
const FAB_SIZE = 36;
// Pointer travel (px) that separates a click from a drag.
const DRAG_THRESHOLD_PX = 6;
// Default anchor offsets from the bottom-right corner; mobile clears #send_form.
const DEFAULT_RIGHT = 20;
const DEFAULT_BOTTOM = 80;
const DEFAULT_RIGHT_MOBILE = 16;
const DEFAULT_BOTTOM_MOBILE = 120;

// Toggle handler wired by launcher.js (toggleLauncherPanel). Stored at module
// level so re-mounts keep the same behaviour without re-passing it.
let _onToggle = null;
let _resizeBound = false;

function getFab() {
    return document.getElementById(FAB_ID);
}

function getViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
}

// ── Position math (pure — unit-tested) ──

function defaultPosition(viewport, size, isMobile) {
    const right = isMobile ? DEFAULT_RIGHT_MOBILE : DEFAULT_RIGHT;
    const bottom = isMobile ? DEFAULT_BOTTOM_MOBILE : DEFAULT_BOTTOM;
    return {
        left: Math.max(0, viewport.width - size - right),
        top: Math.max(0, viewport.height - size - bottom),
    };
}

function clampPosition(pos, viewport, size) {
    return {
        left: Math.max(0, Math.min(pos.left, viewport.width - size)),
        top: Math.max(0, Math.min(pos.top, viewport.height - size)),
    };
}

// ST's top bar paints above the FAB (3005 vs 2999 — see style.css): measure how
// much of it covers the viewport top so positions can be clamped below it.
// Mirrors window.js's mobile inset logic; kept separate because that one only
// runs on mobile viewports, while the FAB exists on desktop too.
function getStTopBarInset() {
    const bar = document.getElementById('top-bar');
    if (!bar) return 0;
    const bottom = bar.getBoundingClientRect().bottom;
    // A bar scrolled/hid out of view (bottom <= 0) contributes nothing.
    return Number.isFinite(bottom) && bottom > 0 ? Math.min(bottom, window.innerHeight) : 0;
}

// Pure core of the chrome-aware clamp: never above the top-bar inset, never
// outside the viewport (the viewport still wins on absurdly tiny windows).
function clampFabPosition(pos, viewport, size, topInset) {
    const clamped = clampPosition(pos, viewport, size);
    if (topInset > 0) {
        clamped.top = Math.min(Math.max(clamped.top, topInset), viewport.height - size);
    }
    return clamped;
}

function clampToViewportWithChrome(pos) {
    return clampFabPosition(pos, getViewport(), FAB_SIZE, getStTopBarInset());
}

/**
 * Pick the mount position: the saved one when it is still fully inside the
 * viewport, the corner default otherwise.
 * @param {{left: number, top: number}|null} saved parsed localStorage payload
 */
function computeRestoredPosition(saved, viewport, size, isMobile) {
    if (saved
        && Number.isFinite(saved.left) && Number.isFinite(saved.top)
        && saved.left >= 0 && saved.top >= 0
        && saved.left + size <= viewport.width
        && saved.top + size <= viewport.height) {
        return { left: saved.left, top: saved.top };
    }
    return defaultPosition(viewport, size, isMobile);
}

// ── Position persistence ──

function restorePosition(icon) {
    let saved = null;
    try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch {
        try { localStorage.removeItem(POSITION_KEY); } catch { /* quota/private mode */ }
    }
    const pos = clampToViewportWithChrome(computeRestoredPosition(saved, getViewport(), FAB_SIZE, isMobileViewport()));
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    icon.style.right = 'auto';
    icon.style.bottom = 'auto';
}

function persistPosition(icon) {
    try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({
            left: parseFloat(icon.style.left),
            top: parseFloat(icon.style.top),
        }));
    } catch { /* quota/private mode — position just won't survive a restart */ }
}

// ── Drag (Pointer Events + capture) ──

function makeDraggable(icon) {
    let dragging = false;
    let offsetX = 0, offsetY = 0;
    let startX = 0, startY = 0;

    icon.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = false;
        const r = icon.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        startX = r.left;
        startY = r.top;
        icon.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    icon.addEventListener('pointermove', (e) => {
        if (!icon.hasPointerCapture(e.pointerId)) return;
        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;
        if (!dragging && Math.hypot(rawX - startX, rawY - startY) > DRAG_THRESHOLD_PX) {
            dragging = true;
            icon.classList.add('gls_fab_dragging');
        }
        const pos = clampToViewportWithChrome({ left: rawX, top: rawY });
        icon.style.left = `${pos.left}px`;
        icon.style.top = `${pos.top}px`;
    });

    icon.addEventListener('pointerup', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        const wasDragging = dragging;
        dragging = false;
        icon.classList.remove('gls_fab_dragging');
        if (wasDragging) {
            persistPosition(icon);
            // The FAB may have settled over (or out of) the panel header —
            // re-evaluate the click-passthrough for the new spot.
            syncFloatingLauncher();
        }
        else if (_onToggle) _onToggle();
    });

    icon.addEventListener('pointercancel', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        dragging = false;
        icon.classList.remove('gls_fab_dragging');
    });

    icon.style.touchAction = 'none';
}

// Keep the FAB inside the viewport when the window shrinks under it.
function onWindowResize() {
    const icon = getFab();
    if (!icon) return;
    const left = parseFloat(icon.style.left);
    const top = parseFloat(icon.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const pos = clampToViewportWithChrome({ left, top });
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    // Resizing also moves/resizes the panel — the header overlap may have
    // appeared or disappeared.
    syncFloatingLauncher();
}

// window.js keeps its own mobile check private; mirror the viewport-width rule
// (the touch/short-side refinement there only picks the panel layout, not the
// FAB's default anchor).
function isMobileViewport() {
    return window.innerWidth < MOBILE_BREAKPOINT;
}

// ── Public API ──

/**
 * Mount (or re-sync) the floating launcher. No-op regarding mode: launcher.js's
 * ensureLauncher() decides from settings.launcherMode whether to call this.
 * @param {{onToggle?: Function}} [opts]
 */
export function ensureFloatingLauncher({ onToggle } = {}) {
    if (onToggle) _onToggle = onToggle;
    let icon = getFab();
    if (!icon) {
        icon = document.createElement('div');
        icon.id = FAB_ID;
        icon.className = 'gls_fab';
        icon.tabIndex = 0;
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', DISPLAY_NAME);
        icon.title = t('Footnotes — click to toggle, drag to move');
        // Same FA glyph as the QR-bar launcher (launcher.js) and the per-message
        // regen button — the three "footnotes" controls read as one family. FA is
        // loaded globally by SillyTavern.
        icon.innerHTML = '<span aria-hidden="true"><i class="fa-solid fa-superscript"></i></span>';

        icon.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (_onToggle) _onToggle();
            }
        });

        document.body.appendChild(icon);
        restorePosition(icon);
        makeDraggable(icon);
        if (!_resizeBound) {
            _resizeBound = true;
            window.addEventListener('resize', onWindowResize);
        }
    }
    syncFloatingLauncher();
    return icon;
}

/**
 * Pure overlap test (unit-tested): does the FAB rect intersect the given
 * rect? Used to detect a FAB parked over the panel header — see
 * syncFloatingLauncher() for why that needs a pointer-events passthrough.
 */
function rectsIntersect(a, b) {
    if (!a || !b) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Refresh the active (panel-open) highlight, and reconcile the header
 * passthrough. Called from ensureFloatingLauncher() on every ensureLauncher()
 * pass (i.e. on every panel open/close via the launcher flows) and from the
 * FAB's own drag-end/resize paths.
 *
 * Passthrough rationale: the FAB must paint ABOVE the panel (z-order contract;
 * on mobile the fullscreen sheet would bury its own toggle otherwise), but a
 * FAB parked over the panel's HEADER then swallows taps meant for the header
 * controls (Prev/Next/Jump/Clear/✕). While the panel is visible and the FAB
 * geometrically overlaps the header, the FAB is made click-transparent
 * (.gls_fab--passthrough) — taps fall through to the header, the panel's own
 * ✕ remains the way out, and the class clears as soon as the panel closes or
 * the FAB moves.
 */
export function syncFloatingLauncher() {
    const icon = getFab();
    if (!icon) return;
    const visible = panelIsVisible();
    icon.classList.toggle('gls_fab_active', visible);
    let passthrough = false;
    if (visible) {
        const header = document.querySelector('#gls-panel .gls-panel-header');
        if (header) {
            passthrough = rectsIntersect(icon.getBoundingClientRect(), header.getBoundingClientRect());
        }
    }
    icon.classList.toggle('gls_fab--passthrough', passthrough);
}

export function removeFloatingLauncher() {
    const icon = getFab();
    if (icon) icon.remove();
    if (_resizeBound) {
        _resizeBound = false;
        window.removeEventListener('resize', onWindowResize);
    }
}

// Test-only exports (NODE_TEST guard — invisible in the ST browser host).
// `process` is read via globalThis: the bare identifier throws ReferenceError
// in the browser (same pattern as commands.js).
export const _test = (globalThis.process?.env?.NODE_TEST === '1')
    ? { defaultPosition, clampPosition, clampFabPosition, computeRestoredPosition, rectsIntersect, FAB_SIZE, DRAG_THRESHOLD_PX }
    : null;
