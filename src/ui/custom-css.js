// @ts-check
/**
 * Glosses — UI: popup custom CSS layer (Level 3)
 *
 * The third styling layer on top of the token knobs (Level 1) and the skin
 * classes (Level 2): a raw user stylesheet stored in S().customCss and
 * published as two reusable <style> tags in <head>:
 *
 *   #gls-custom-css          the raw text — applies to the page globally,
 *                            exactly like ST's built-in Custom CSS.
 *   #gls-custom-css-preview  a mirrored copy for the settings snapshot
 *                            (.gls-popup-preview twin), where the exact
 *                            class token ".gls-popup" is rewritten to
 *                            ".gls-popup-preview" so editing here restyles
 *                            the preview live. All OTHER gls-popup-* classes
 *                            (.gls-popup-title, .gls-popup-text, …) are
 *                            shared by popup and preview, so they mirror for
 *                            free; :root-scoped rules (knob vars, density /
 *                            shadow classes) reach the preview through the
 *                            raw tag.
 *
 * Publishing is hooked into applyHighlightStyles() (renderer.js) — the same
 * path that republishes tokens on boot / enable / knob changes — so the layer
 * never falls out of sync. applyCustomCss() is idempotent and safe to call at
 * any frequency.
 *
 * Trust level: raw CSS, deliberately NOT sanitized — identical to ST's own
 * Custom CSS (CSS cannot execute JS in modern browsers). The author is the
 * user; the blast radius is their own page.
 *
 * Known cosmetic limitation: a ".gls-popup" occurrence inside a CSS string
 * literal (e.g. content: ".gls-popup") is mirrored too. Harmless in practice.
 */

import { S, t } from '../core.js';

export const STYLE_ID = 'gls-custom-css';
export const MIRROR_ID = 'gls-custom-css-preview';

/**
 * Mirror map for the settings snapshot: rewrite ONLY the exact class token
 * `.gls-popup` to `.gls-popup-preview`. The negative lookahead on [-\w] keeps
 * every compound class (.gls-popup-title / .gls-popup-preview /
 * .gls-popup-skin-*) untouched. Pure.
 * @param {string} css
 * @returns {string}
 */
export function mirrorPopupSelectors(css) {
    return String(css ?? '').replace(/\.gls-popup(?![-\w])/g, '.gls-popup-preview');
}
