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

/**
 * Starter stylesheet for "Insert base template". Comments document every
 * popup target and the useful tokens; the active example (warm paper card)
 * gives an immediate visible change so the feature self-demonstrates. CSS
 * comments cannot ride data-i18n, so this stays English.
 */
export const CUSTOM_CSS_BASELINE = `/* ═════════ Glosses — popup custom CSS ═════════
   Injected as a <style> tag when "Enable custom CSS layer" is on.
   Applies to the whole page (like ST's own Custom CSS) and applies last —
   to beat a skin's own rules, out-specify them (see Notes). Everything
   below is an example — edit or delete freely.

   Targets:
     .gls-popup             popup card (background / border / shadow)
     .gls-popup-header      Copy · Edit · Delete · Close row
     .gls-popup-close       the ✕ button
     .gls-popup-body        content wrapper (padding)
     .gls-popup-title       headword row (.gls-popup-title-idx = the number)
     .gls-popup-text        footnote body (its code/strong/em/del too)
     .gls-popup-action-btn  small header buttons
   Also reachable: chat marker .gls-marker / .gls-sup,
   under-post block .gls-inline-fns / .gls-inline-fn.

   Handy tokens:
     Knob-published tokens (--gls-popup-radius, --gls-popup-maxw,
     --gls-font-family, --gls-font-size, --gls-surface) are written as INLINE
     styles on <html>, so a :root rule can never override them — declare them
     on .gls-popup instead.
     Plain tokens (declare on :root or .gls-popup): --gls-edge, --gls-text,
     --gls-accent, --gls-shadow-float.

   Notes:
   • The settings preview mirrors every ".gls-popup …" rule automatically.
   • To out-specify a skin, e.g. Paper:
       :root.gls-popup-skin-paper .gls-popup { … }
   • This is plain CSS: the browser silently drops mistakes — if nothing
     changes, check the braces. */

/* ── Example: warm paper card ─────────────────────────────── */
.gls-popup {
    --gls-popup-radius: 14px;
    --gls-text: #3b2f1e;
    --gls-text-2: color-mix(in srgb, #3b2f1e 86%, transparent);
    --gls-line: color-mix(in srgb, #3b2f1e 10%, transparent);
    background: linear-gradient(180deg, #f7f0e3, #efe4cf);
    border: 1px solid #d8c7a5;
    color: #3b2f1e;
    box-shadow: 0 4px 14px rgba(90, 70, 40, 0.25);
}
.gls-popup-title {
    color: #6b4f2a;
    border-bottom: 1px solid #d8c7a5;
    padding-bottom: 6px;
}
.gls-popup-text code {
    background: rgba(107, 79, 42, 0.14);
    color: #4a3413;
}
.gls-popup-text strong { color: #8a5a19; }
`;

/**
 * Count the rules the browser actually parsed out of the stylesheet, for the
 * honest status line ("N rules" / "nothing parsed"). Uses the real CSS engine
 * instead of a regex counter — the engine is the only authority on which
 * rules survive. Top-level rules only (an @media block counts as one).
 *
 * Three outcomes:
 *   - engine unavailable (Node test stubs) or present but not constructable
 *     (older Safari/Firefox/Chrome) → null: the caller hides the count;
 *   - engine rejects the sheet wholesale (e.g. @import) → null as well: a
 *     real <style> tag HONORS @import (a constructed sheet cannot), so a
 *     constructed-sheet "0" would be a lie — the count is unknown, not zero;
 *   - parsed → the top-level rule count.
 * @param {string} css
 * @returns {number | null}
 */
export function countCssRules(css) {
    if (typeof globalThis.CSSStyleSheet !== 'function') return null;
    let sheet;
    try {
        sheet = new globalThis.CSSStyleSheet();
    } catch {
        return null; // interface present but not constructable (older engines)
    }
    try {
        sheet.replaceSync(String(css ?? ''));
    } catch {
        // Whole-sheet rejections (e.g. @import) keep zero rules in the
        // constructed sheet, but a real <style> tag honors them — so "0
        // parsed" would be a lie. Report the count as unknown (null), which
        // customCssStatusText renders as the plain "Applied".
        return null;
    }
    return sheet.cssRules.length;
}

/**
 * "Insert base template" semantics: replace empty editor text, otherwise
 * append after a blank line (safe on any existing content). Pure.
 * @param {string} current
 * @param {string} template
 * @returns {string}
 */
export function insertTemplate(current, template) {
    const cur = String(current ?? '');
    if (!cur.trim()) return template;
    const sep = cur.endsWith('\n') ? '' : '\n';
    return `${cur}${sep}\n${template}`;
}

/**
 * The status line under the Custom CSS toggle: empty when nothing is active,
 * "Applied" when the engine can't count (older engines / Node / a whole-sheet
 * rejection such as @import), a rule count when it can, and an explicit
 * diagnosis when the engine parsed the text fine but NOTHING survived
 * (almost always unbalanced braces). Pure.
 * @param {string} css
 * @returns {string}
 */
export function customCssStatusText(css) {
    if (!String(css ?? '').trim()) return '';
    const rules = countCssRules(css);
    if (rules == null) return t('Applied');
    if (rules > 0) return t('Applied — {n} rules').split('{n}').join(String(rules));
    return t('No rules parsed — check the CSS syntax');
}

/**
 * Create-once, reuse-forever style tag. textContent is only written when it
 * differs, so repeated applies during typing don't force style recalcs.
 */
function syncStyleTag(id, css) {
    const head = document.head;
    if (!head) return; // stub runtimes / detached documents
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('style');
        el.id = id;
        head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
}

/**
 * Publish S().customCss into the live <style> tags and refresh the settings
 * status line. Hooked into applyHighlightStyles() (Task 5) so every existing
 * publish path (boot, enable, knob changes) carries this layer for free.
 */
export function applyCustomCss() {
    // Both gates must pass: the layer's own checkbox AND the Glosses master
    // toggle — killing the extension must unload its page-global CSS the same
    // way it unloads highlights and the launcher.
    const enabled = S().enabled !== false && S().customCssEnabled !== false;
    const css = enabled ? String(S().customCss ?? '') : '';
    syncStyleTag(STYLE_ID, css);
    syncStyleTag(MIRROR_ID, mirrorPopupSelectors(css));
    // Republishes are frequent (every knob change rides applyHighlightStyles),
    // and the element is aria-live="polite" — don't re-mutate it with
    // identical text.
    const statusEl = document.getElementById('gls_custom_css_status');
    if (statusEl) {
        const status = customCssStatusText(css);
        if (statusEl.textContent !== status) statusEl.textContent = status;
    }
}

/**
 * Remove both custom-CSS <style> tags. Called from index.js cleanup() so a
 * disabled/cleaned extension cannot leave page-global user CSS behind with
 * its toggle gone — the same teardown contract as removeLauncher()/destroyPanel().
 */
export function removeCustomCssTags() {
    for (const id of [STYLE_ID, MIRROR_ID]) {
        const el = document.getElementById(id);
        if (el?.remove) el.remove();
    }
}
