// @ts-check
/**
 * Glosses — Highlight/high-chrome style publisher.
 *
 * Extracted verbatim from renderer.js (R-7.3 module split): FONT_STACKS +
 * applyHighlightStyles — the single publish path for :root custom properties,
 * popup skin/density/shadow classes and the custom-CSS layer. index.js and
 * settings-sync call it on every knob change.
 */

import { S } from '../core.js';
import { SKINS } from './skin-gallery.js';
import { applyCustomCss } from './custom-css.js';

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
    const skin = SKINS.includes(s.popupTheme) ? s.popupTheme : 'adaptive';
    for (const k of SKINS) root.classList.remove(`gls-popup-skin-${k}`);
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

