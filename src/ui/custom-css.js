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

import { S, t, saveSettings } from '../core.js';

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
     styles on <html> (surface: whenever the theme tint parses), so a :root
     rule usually cannot override them — declare them on .gls-popup instead.
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
    if (rules > 0) return t('Applied — rules: {n}').split('{n}').join(String(rules));
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
 * status line. Hooked into applyHighlightStyles() so every existing
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

/**
 * Close the editor dialog if it is open (no-op when never built or already
 * closed). Called from index.js cleanup() so a disabled extension doesn't
 * leave an open dialog floating over a dead UI.
 */
export function closeCssEditor() {
    _editor?.close();
}

// ── Editor dialog ───────────────────────────────────────────────────────────
// Built lazily on first open; the DOM is kept for reuse but the overlay is
// mounted to document.body TRANSIENTLY (append on open, remove on close) so
// nothing lingers after the extension's cleanup() — unlike the settings
// panel, the overlay lives outside #gls_settings_container. Live apply on
// input (300 ms debounce); close always commits pending text first, so
// Escape / outside click / Done can never lose work.

const escHtml = (s) => String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function debounce(fn, ms) {
    let id = 0;
    return (...args) => {
        clearTimeout(id);
        id = setTimeout(() => fn(...args), ms);
    };
}

/** Live popup preview twin for the dialog's right column. */
function buildPreviewTwin() {
    const wrap = document.createElement('div');
    wrap.className = 'gls-popup-preview gls-css-twin';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = [
        '<div class="gls-popup-header">',
        '<div class="gls-popup-actions">',
        '<span class="gls-popup-action-btn" title="Copy"><i class="fa-solid fa-copy fa-fw" aria-hidden="true"></i></span>',
        '<span class="gls-popup-action-btn" title="Edit"><i class="fa-solid fa-pen fa-fw" aria-hidden="true"></i></span>',
        '<span class="gls-popup-action-btn" title="Delete"><i class="fa-solid fa-trash-can fa-fw" aria-hidden="true"></i></span>',
        '</div>',
        '<span class="gls-popup-close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></span>',
        '</div>',
        '<div class="gls-popup-body">',
        `<div class="gls-popup-title"><sup class="gls-popup-title-idx">1</sup><span>${escHtml(t('Kraken'))}</span></div>`,
        `<p class="gls-popup-text">${escHtml(t('A colossal sea beast; sailors say its arms can crush a whole fleet.'))}</p>`,
        '</div>',
    ].join('');
    return wrap;
}

let _editor = null;

/**
 * Open (building on first use) the Custom CSS editor dialog: monospace editor
 * with Tab support and live apply, live preview twin of the popup, rule-count
 * status, Insert-base-template / Reset / Done. Styles: .gls-css-* in style.css.
 */
export function openCssEditor() {
    if (!_editor) _editor = buildEditor();
    _editor.open();
}

function buildEditor() {
    const overlay = document.createElement('div');
    overlay.className = 'gls-css-overlay';
    overlay.hidden = true;

    const dialog = document.createElement('div');
    dialog.className = 'gls-css-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', t('Popup CSS editor'));

    // Header
    const head = document.createElement('div');
    head.className = 'gls-css-dialog-head';
    const title = document.createElement('div');
    title.className = 'gls-css-dialog-title';
    title.textContent = t('Popup CSS editor');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'menu_button menu_button_icon gls-css-close';
    closeBtn.setAttribute('aria-label', t('Close'));
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    head.appendChild(title);
    head.appendChild(closeBtn);

    // Body: editor column (highlight layer under a transparent-text textarea)
    // + live preview column.
    const cols = document.createElement('div');
    cols.className = 'gls-css-dialog-cols';

    const editorCol = document.createElement('div');
    editorCol.className = 'gls-css-editor-col';
    const hlPre = document.createElement('pre');
    hlPre.className = 'gls-css-hl';
    hlPre.setAttribute('aria-hidden', 'true');
    const hlCode = document.createElement('code');
    hlPre.appendChild(hlCode);
    const ta = document.createElement('textarea');
    ta.className = 'gls-css-input';
    ta.spellcheck = false;
    ta.setAttribute('aria-label', t('Custom CSS'));
    editorCol.appendChild(hlPre);
    editorCol.appendChild(ta);

    const previewCol = document.createElement('div');
    previewCol.className = 'gls-css-preview-col';
    const prevLabel = document.createElement('div');
    prevLabel.className = 'gls-s-preview-label';
    prevLabel.textContent = t('Live preview');
    previewCol.appendChild(prevLabel);
    previewCol.appendChild(buildPreviewTwin());

    cols.appendChild(editorCol);
    cols.appendChild(previewCol);

    // Footer
    const foot = document.createElement('div');
    foot.className = 'gls-css-dialog-foot';
    const status = document.createElement('span');
    status.className = 'gls-css-status gls-s-hint';
    const tplBtn = document.createElement('button');
    tplBtn.type = 'button';
    tplBtn.className = 'menu_button';
    tplBtn.textContent = t('Insert base template');
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'menu_button';
    resetBtn.textContent = t('Reset');
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'menu_button gls-css-done';
    doneBtn.textContent = t('Done');
    foot.appendChild(status);
    foot.appendChild(tplBtn);
    foot.appendChild(resetBtn);
    foot.appendChild(doneBtn);

    dialog.appendChild(head);
    dialog.appendChild(cols);
    dialog.appendChild(foot);
    overlay.appendChild(dialog);

    // ── Behavior ──
    const commit = () => {
        const value = ta.value;
        if (S().customCss === value) return;
        S().customCss = value;
        applyCustomCss();
        saveSettings();
    };
    const applyLive = debounce(() => {
        commit();
        status.textContent = customCssStatusText(S().customCss);
    }, 300);
    // Resolved per call: the stub runtime and old ST builds have no hljs
    // (plain-textarea fallback), and a build-time capture would freeze that
    // decision into the dialog singleton forever.
    const syncHighlight = () => {
        const hljs = getHljs();
        if (!hljs) { hlPre.hidden = true; return; }
        try {
            hlCode.innerHTML = hljs.highlight(ta.value, { language: 'css' }).value;
            hlPre.hidden = false;
        } catch {
            hlPre.hidden = true; // engine hiccup must never block typing
        }
    };
    // The textarea owns scrolling; the pre mirrors it so glyphs stay aligned.
    ta.addEventListener('scroll', () => {
        hlPre.scrollTop = ta.scrollTop;
        hlPre.scrollLeft = ta.scrollLeft;
    });
    const refresh = () => {
        applyLive();
        syncHighlight();
    };

    ta.addEventListener('input', refresh);
    // Tab inserts 4 spaces instead of moving focus (CSS is whitespace-meaningful).
    ta.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        ta.value = ta.value.slice(0, start) + '    ' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 4;
        refresh();
    });

    tplBtn.addEventListener('click', () => {
        ta.value = insertTemplate(ta.value, CUSTOM_CSS_BASELINE);
        refresh();
        ta.focus();
    });
    resetBtn.addEventListener('click', () => {
        // Destructive: the editor text IS the stored setting, so confirm.
        if (!window.confirm(t('Clear custom CSS?'))) return;
        ta.value = '';
        refresh();
    });

    const onKey = (e) => { if (e.key === 'Escape') api.close(); };
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) api.close(); });
    closeBtn.addEventListener('click', () => api.close());
    doneBtn.addEventListener('click', () => api.close());

    const api = {
        open() {
            ta.value = String(S().customCss ?? '');
            syncHighlight(); // paint the layer for the freshly loaded text
            status.textContent = customCssStatusText(ta.value);
            // Transient mount, removed on close. "hidden ⇔ detached" is an
            // invariant only open()/close() mutate, so it doubles as the guard
            // keeping a repeated open() from re-appending a mounted overlay.
            if (overlay.hidden) document.body.appendChild(overlay);
            overlay.hidden = false;
            document.addEventListener('keydown', onKey);
            ta.focus();
        },
        close() {
            overlay.hidden = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            commit(); // the 300 ms debounce can swallow the last keystrokes
            saveSettings();
        },
    };
    return api;
}

/**
 * ST bundles highlight.js and exposes it as SillyTavern.libs.hljs (verified on
 * the release branch: public/script.js imports hljs from lib.js into `libs`).
 * Returns null when unavailable — the editor then stays a plain textarea.
 */
export function getHljs() {
    try {
        return globalThis.SillyTavern?.libs?.hljs || null;
    } catch {
        return null;
    }
}
