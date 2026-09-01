// @ts-check
/**
 * Glosses — UI: Theme sync (opaque background)
 *
 * SillyTavern exposes no opaque "chrome background" CSS token: the only token
 * with the right hue, --SmartThemeBlurTintColor, carries a theme-dependent
 * alpha that approaches 0 on transparent themes — so the popup, floating panel,
 * and inline footnote block rendered see-through. The CSS-only fix in style.css
 * (relative color syntax `rgb(from ... r g b)` inside an @supports block) only
 * covers modern browsers (~85%, Chrome 131+/FF 133+/Safari 18+) and leaves
 * older browsers and Samsung Internet with the broken translucent fallback.
 *
 * This module is the primary, cross-browser layer: it reads the computed
 * --SmartThemeBlurTintColor, forces its alpha to 1 (preserving hue/lightness,
 * so dark themes stay dark and light themes stay light), and writes the solid
 * color back to --gls-bg on documentElement. The inline value wins over both
 * the :root translucent default and the @supports CSS derivation.
 *
 * ST emits no theme-change event (event_types has no THEME_*), and applies
 * themes by writing inline styles to documentElement via applyThemeColor(). We
 * therefore watch documentElement's `style` attribute with a MutationObserver
 * and recompute on any change (rAF-debounced). Ported from the sister-extension
 * pattern; the pure color coercion is unit-tested via forceOpaqueBg().
 */

import { log, warn } from '../core.js';

const FALLBACK_BG = '#1e1e1e';

/**
 * Parse an opaque rgb()/hex color string into [r, g, b] channels.
 * Accepts exactly what forceOpaqueBg emits (plus a little slack). Pure.
 * @returns {number[] | null} channels in 0-255, or null when unparseable.
 */
function parseChannels(color) {
    const s = (color || '').trim();
    const m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (m) return [+m[1], +m[2], +m[3]];
    const h = s.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (h) {
        const hex = h[1].length === 3
            ? h[1].split('').map(c => c + c).join('')
            : h[1];
        return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    }
    return null;
}

/**
 * WCAG-style relative luminance (0 = black, 1 = white). Pure.
 * @param {number[]} ch [r, g, b]
 */
function relativeLuminance(ch) {
    const lin = ch.map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Mix channels toward a target by `amount` (0 = unchanged, 1 = target). Pure.
 * @param {number[]} ch
 * @param {number[]} target
 * @param {number} amount
 */
function mixToward(ch, target, amount) {
    return ch.map((v, i) => Math.round(v + (target[i] - v) * amount));
}

/**
 * Derive the floating-card surface (popup / panel) from the opaque theme tint:
 * shifted one step AWAY from the chat background - darker on dark themes,
 * lighter on light ones - so the card reads as a separate layer even when its
 * hue matches the chat (the gray-on-gray blend). Hue is preserved; only
 * lightness moves, so cappuccino stays cappuccino and pink stays pink.
 * Pure and DOM-free so it is unit-testable.
 *
 * @param {string} opaque Color string (typically forceOpaqueBg's output).
 * @param {{ shift?: number }} [opts] shift = 0..1 lightness step, default 0.12.
 * @returns {string | null} An opaque rgb() string, or null when unparseable
 *   (caller keeps its previous surface value in that case).
 */
export function deriveSurfaceColor(opaque, { shift = 0.12 } = {}) {
    const ch = parseChannels(opaque);
    if (!ch) return null;
    const target = relativeLuminance(ch) < 0.5 ? [0, 0, 0] : [255, 255, 255];
    const mixed = mixToward(ch, target, shift);
    return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

let _observer = null;
let _rafId = 0;

/**
 * Force a CSS color string to full opacity, preserving its hue/lightness.
 * Pure and DOM-free so it is unit-testable. Accepts the formats SillyTavern
 * writes to --SmartThemeBlurTintColor (rgba/rgb/hex with optional alpha);
 * anything unparseable yields the fallback.
 *
 * @param {string} input  Color string from getComputedStyle (may be '' or garbage).
 * @param {string} [fallback='#1e1e1e']  Value returned when input is unusable.
 * @returns {string} An opaque color string.
 */
export function forceOpaqueBg(input, fallback = FALLBACK_BG) {
    const s = (input || '').trim();
    if (!s) return fallback;

    // rgba(r,g,b,a) / rgb(r,g,b,a) → drop the alpha channel.
    const rgbaMatch = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+)?\s*\)$/i);
    if (rgbaMatch) {
        return `rgb(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]})`;
    }

    // #rrggbbaa (8-digit hex with alpha) → strip the alpha pair.
    if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7);
    // #rrggbb / #rgb — already opaque.
    if (/^#[0-9a-f]{6}$/i.test(s) || /^#[0-9a-f]{3}$/i.test(s)) return s;

    // Unknown format (named color, hsl, etc.) — don't guess.
    return fallback;
}

/**
 * Read ST's theme tint, force it opaque, and write it to --gls-bg on
 * documentElement. Safe to call repeatedly.
 */
export function applyOpaqueBackground() {
    try {
        const root = document.documentElement;
        const raw = getComputedStyle(root).getPropertyValue('--SmartThemeBlurTintColor');
        const opaque = forceOpaqueBg(raw);
        root.style.setProperty('--gls-bg', opaque);
        // Floating-card surface: same hue, one lightness step away from the
        // chat background (see deriveSurfaceColor). Falls back to the CSS
        // --gls-bg value when the tint is unparseable.
        const surface = deriveSurfaceColor(opaque);
        if (surface) root.style.setProperty('--gls-surface', surface);
        else root.style.removeProperty('--gls-surface');
    } catch (e) {
        warn('theme-sync: could not apply opaque background:', e);
    }
}

/**
 * Apply the opaque background once and start watching for ST theme changes.
 * Idempotent — a second call is a no-op while the observer is attached.
 * Must be paired with disconnectThemeSync() in cleanup().
 */
export function initThemeSync() {
    applyOpaqueBackground();
    if (_observer) return;

    // requestAnimationFrame debounce: a theme switch rewrites several custom
    // properties at once, which would otherwise fire N mutations back-to-back.
    const scheduleApply = () => {
        if (_rafId) return;
        _rafId = requestAnimationFrame(() => {
            _rafId = 0;
            applyOpaqueBackground();
        });
    };

    try {
        _observer = new MutationObserver(scheduleApply);
        _observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['style'],
        });
        log('theme-sync: watching documentElement for theme changes');
    } catch (e) {
        warn('theme-sync: MutationObserver unavailable; background will not track live theme changes:', e);
        _observer = null;
    }
}

/**
 * Tear down the theme-change observer. Safe to call when not initialized.
 */
export function disconnectThemeSync() {
    if (_observer) {
        _observer.disconnect();
        _observer = null;
    }
    if (_rafId) {
        cancelAnimationFrame(_rafId);
        _rafId = 0;
    }
}
