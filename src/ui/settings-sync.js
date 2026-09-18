// @ts-check
/**
 * Glosses — UI: Settings panel sync
 * DOM ↔ state bridge for the ST settings panel (settings.html), plus the prompt
 * cache invalidation hooks and connection-profile dropdown population.
 *
 * Ported 1:1 from SillyTavern-Footnotes (bindSettingsUI/bindCb/bindNum/
 * updateSrcPanels/updatePromptPanels/populateProfiles).
 */

import {
    state, S, saveSettings, t, getApiKey, setApiKey, notifyUser, warn, getCtx,
} from '../core.js';
import { applyHighlightStyles, removeHighlights, restoreHighlightsAll, reapplyHighlightsAll } from '../renderer.js';
import { getProfiles, getProfileDetails, confirmInsecureEndpoint } from '../connection.js';
import { classifyEndpoint, isOriginAllowed } from '../infrastructure/endpoint-policy.js';
import { updatePanel, invalidateAiMsgCache, panelInvalidate } from './window.js';
import { buildPopupHeader } from './popup-header.js';
import { buildSkinGallery } from './skin-gallery.js';
import { ensureLauncher } from './launcher.js';
import { initScrollObserver } from '../events.js';
import {
    populateSoundSelect, invalidateSoundCache, playSound,
    isCustomSoundId, resolveSoundId, nextCustomKey, glsSoundFileName,
    normalizeSoundFiles, deleteCustomSound, parseDataUrl,
} from '../sound.js';
import { uploadUserFile } from '../user-files.js';
import { getChatLoreConfig, saveChatLoreConfig } from '../lorebooks.js';
import { buildColorPicker } from './color-picker.js';
import { openCssEditor } from './custom-css.js';

// ══════════════════════════════════════════════════════════════════════════════
// PRESETS (spec §6.1)
// ══════════════════════════════════════════════════════════════════════════════
// Short-name preset table. Key = what's stored in S().selectedPreset; value =
// the partial settings merge applied on selection. Fields not listed here are
// left untouched. The four curated entries cover the most common style+lang
// combos; '(no preset / manual)' is the sentinel represented by '' (no entry).
//
// Apply() = setPreset(key) (below), wired from the dropdown change listener in
// bindSettingsUI. Any manual edit of one of the preset's constituent fields
// calls clearPresetOnManualEdit() so the dropdown auto-reverts to the sentinel
// (the user is now in manual mode).
export const PRESETS = {
    'pratchett50-ru':   { promptStyle: 'pratchett50', outputLanguage: 'ru' },
    'lang-en-ru-a2':    {
        promptStyle: 'language',   outputLanguage: 'ru',
        targetLanguage: 'en',      cefrLevel: 'a1a2',
    },
    'academic-lore-ru': { promptStyle: 'academic',    outputLanguage: 'ru' },
    'meta-ru':          { promptStyle: 'meta_plus',   outputLanguage: 'ru' },
};

/** Apply a preset by merging its fields into S(), saving, and forcing
 *  the downstream controls (style dropdown, language panel, hybrid
 *  toggles) to re-read from state. The caller also clears/sets
 *  S().selectedPreset. Defensive on missing key (no-op). */
function setPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;
    const s = S();
    for (const [k, v] of Object.entries(preset)) {
        s[k] = (k === 'hybridLenses') ? { ...v } : v;
    }
    s.selectedPreset = key;
    saveSettings();
    // Re-sync every downstream control the preset touched so the dropdowns +
    // checkboxes reflect the merged state (not a stale prior render).
    _invalidateLanguageCache();
    updatePromptPanels();
    updatePresetShowing();
}

/** Sync the visible settings controls DOWN to current S() after a preset
 *  apply (or after loadSettings rehydrates a stored selectedPreset on init).
 *  Touches: prompt style, output lang, target lang, CEFR, and the 6 hybrid
 *  lens checkboxes. No-ops for elements that aren't present. */
function updatePresetShowing() {
    const s = S();
    const psEl = document.getElementById('gls_prompt_style');
    if (psEl) psEl.value = s.promptStyle;
    const olEl = document.getElementById('gls_output_language');
    if (olEl) olEl.value = s.outputLanguage || 'ru';
    const tlEl = document.getElementById('gls_target_language');
    if (tlEl) tlEl.value = s.targetLanguage;
    const cefrEl = document.getElementById('gls_cefr_level');
    if (cefrEl) cefrEl.value = s.cefrLevel;
    for (const lens of ['language', 'pratchett', 'canon', 'academic', 'meta', 'expansion']) {
        const el = document.getElementById(`gls_hybrid_lens_${lens}`);
        if (el) el.checked = !!s.hybridLenses?.[lens];
    }
    const presetSel = document.getElementById('gls_preset');
    if (presetSel) presetSel.value = s.selectedPreset || '';
}

/** Clear selectedPreset (called from any downstream control's manual edit
 *  so the dropdown auto-reverts to the sentinel). Does NOT change any other
 *  settings; the user's manual edit stays as written. No-op when no preset
 *  was active. */
function clearPresetOnManualEdit() {
    if (S().selectedPreset) {
        S().selectedPreset = '';
        saveSettings();
        const sel = document.getElementById('gls_preset');
        if (sel) sel.value = '';
    }
}

let _settingsBound = false;
// CHAT_CHANGED hook for the per-chat lore controls: bound once for the page
// lifetime (the settings DOM persists across bind/unbind, and the listener is
// intentionally NOT routed through the bind-scoped AbortController — it must
// re-sync after every re-enable). syncLoreControls itself is DOM-only.
let _loreChatHook = false;
// Stage 7: module-owned AbortController for the settings panel. bindSettingsUI
// creates a fresh controller; every listener it attaches is aborted (removed)
// on unbindSettingsUI. The `on()` helper routes all addEventListener calls
// through the active controller's signal, so a disable/enable cycle never
// accumulates duplicate listeners on a still-present settings root (the guard
// flag alone couldn't remove listeners; DOM removal of the settings container
// was the only previous cleanup path).
let _settingsAbort = null;

/**
 * addEventListener routed through the settings AbortController. Outside a
 * bind/unbind cycle (no active controller) it behaves exactly like
 * addEventListener so helper functions called from non-bind paths are safe.
 *
 * NOTE: this MUST call el.addEventListener directly. The previous version
 * recursed into itself in both branches (never reaching addEventListener),
 * which overflowed the stack on the first bind in a real browser (RangeError)
 * and silently killed the whole init() after the settings panel loaded.
 * Unit tests missed it because the stub document returns null elements, so
 * on() was never reached. See tests/settings-on-binding.test.mjs.
 */
function on(el, ev, fn, opts = {}) {
    if (!el?.addEventListener) return;
    el.addEventListener(ev, fn, _settingsAbort ? { ...opts, signal: _settingsAbort.signal } : opts);
}

export function bindSettingsUI() {
    if (_settingsBound) return;
    _settingsBound = true;
    _settingsAbort = new AbortController();
    const $ = id => document.getElementById(id);

    // ── Accordion toggles ──
    document.querySelectorAll('#gls_settings .gls-s-section-header').forEach(btn => {
        on(btn, 'click', () => {
            const body = btn.nextElementSibling;
            const chevron = btn.querySelector('.gls-s-chevron');
            const open = !body.hidden;
            body.hidden = open;
            btn.setAttribute('aria-expanded', String(!open));
            if (chevron) chevron.style.transform = open ? '' : 'rotate(-180deg)';
        });
    });

    // §6.2: Advanced-lenses namespaced sub-accordion (the second-tier analogue
    // of gls-s-section-header above). Default collapsed — the lens toggles +
    // custom-lens editor live behind an explicit "Advanced lenses" click so
    // the median user isn't presented with power-user nesting under a flat UI.
    document.querySelectorAll('#gls_settings .gls-s-sub-section-toggle').forEach(btn => {
        on(btn, 'click', () => {
            const body = btn.nextElementSibling;
            const chevron = btn.querySelector('.gls-s-chevron');
            const open = !body.hidden;
            body.hidden = open;
            btn.setAttribute('aria-expanded', String(!open));
            if (chevron) chevron.style.transform = open ? '' : 'rotate(-180deg)';
        });
    });

    // Master toggle
    bindCb('gls_enabled', 'enabled', () => {
        if (!S().enabled) document.querySelectorAll('.mes[mesid]').forEach(el => removeHighlights(el));
        else restoreHighlightsAll();
        applyHighlightStyles();
        // Mount/remove the 🪶 launcher so it tracks the enabled state. Without
        // this the button lingered in #qr--bar after disabling until a chat
        // switch rebuilt the bar (ensureLauncher removes when !enabled).
        ensureLauncher();
    });

    // §6.1: Presets dropdown — primary one-click configurator at the top of the
    // Prompt section. Selecting a preset merges its fields into S() and syncs
    // downstream controls; picking the sentinel ('') just clears selectedPreset
    // without touching other fields. Any manual edit of a downstream control
    // calls clearPresetOnManualEdit() (wired in those listeners below). On
    // init we mirror S().selectedPreset into the select so a rehydrated
    // preset selection from a loaded settings blob is reflected in the UI.
    const presetSel = $('gls_preset');
    if (presetSel) {
        presetSel.value = S().selectedPreset || '';
        on(presetSel, 'change', async () => {
            const key = presetSel.value;
            if (!key) {
                // Sentinel picked — clear the flag, don't touch other settings.
                S().selectedPreset = '';
                saveSettings();
                return;
            }
            await setPreset(key);
            updatePresetShowing();
        });
    }

    // Source (segmented picker)
    syncSegSource();
    document.querySelectorAll('#gls_source [data-gls-src]').forEach(btn => {
        on(btn, 'click', () => {
            S().source = btn.dataset.glsSrc;
            saveSettings();
            syncSegSource();
            updateSrcPanels();
        });
    });

    // Profile
    const profSel = $('gls_profile_select');
    if (profSel) {
        profSel.value = S().selectedProfile;
        on(profSel, 'change', () => {
            S().selectedProfile = profSel.value;
            saveSettings();
            updateProfileModelInfo();
        });
    }
    on($('gls_profile_refresh'), 'click', () => populateProfiles());

    // Custom endpoint + model
    const epEl = $('gls_custom_endpoint');
    if (epEl) {
        epEl.value = S().customEndpoint || '';
        on(epEl, 'input', () => { S().customEndpoint = epEl.value; saveSettings(); refreshHttpConfirm(); });
    }
    bindHttpConfirm();
    const cmEl = $('gls_custom_model');
    if (cmEl) {
        cmEl.value = S().customModel || '';
        on(cmEl, 'input', () => { S().customModel = cmEl.value; saveSettings(); });
    }
    // Custom API key (localforage-backed; never written to settings JSON)
    const akEl = $('gls_custom_apikey');
    if (akEl) {
        on(akEl, 'change', () => { setApiKey(akEl.value).catch(() => {}); });
        syncCustomApiKeyField(akEl);
    }

    // Prompt style
    const psEl = $('gls_prompt_style');
    if (psEl) {
        psEl.value = S().promptStyle;
        on(psEl, 'change', () => {
            S().promptStyle = psEl.value;
            // §6.1: any manual edit deselects the current preset (manual mode).
            clearPresetOnManualEdit();
            saveSettings();
            updatePromptPanels();
        });
    }
    updatePromptPanels();

    on($('gls_custom_prompt'), 'input', function () {
        S().customPrompt = this.value;
        saveSettings();
    });
    if ($('gls_custom_prompt')) $('gls_custom_prompt').value = S().customPrompt;

    // Language (for the 'language' prompt style)
    const tlEl = $('gls_target_language');
    if (tlEl) {
        // Localise <optgroup> labels — data-i18n no-ops on optgroup (it
        // renders from the `label` attribute, not textContent), so we set
        // `label` directly via t().
        tlEl.querySelectorAll('optgroup[data-gls-i18n-optgroup]').forEach(og => {
            og.label = t(og.dataset.glsI18nOptgroup);
        });
        tlEl.value = S().targetLanguage;
        on(tlEl, 'change', () => {
            S().targetLanguage = tlEl.value;
            clearPresetOnManualEdit();   // §6.1
            _invalidateLanguageCache();
            saveSettings();
        });
    }
    const cefrEl = $('gls_cefr_level');
    if (cefrEl) {
        cefrEl.value = S().cefrLevel;
        on(cefrEl, 'change', () => {
            S().cefrLevel = cefrEl.value;
            clearPresetOnManualEdit();   // §6.1
            _invalidateLanguageCache();
            saveSettings();
        });
    }

    // Hybrid lens toggles. Each flip changes the active lens signature →
    // the hybrid cache key changes → _invalidateLanguageCache drops stale
    // hybrid prompts and loadPromptStyle rebuilds on next generation.
    // Toggling the Language lens also reveals/hides gls_language_panel
    // (handled by updatePromptPanels, called here).
    for (const lens of ['language', 'pratchett', 'canon', 'academic', 'meta', 'expansion']) {
        const el = $(`gls_hybrid_lens_${lens}`);
        if (!el) continue;
        el.checked = !!S().hybridLenses?.[lens];
        on(el, 'change', () => {
            S().hybridLenses[lens] = el.checked;
            clearPresetOnManualEdit();   // §6.1: manual lens edit = manual mode
            _invalidateLanguageCache();
            saveSettings();
            updatePromptPanels();
        });
    }

    // Custom hybrid lenses (user-authored roles). Wired together so any
    // mutation flips the hybrid cache + persists — lets the user build a
    // universal prompt from built-in + their own lenses. See
    // _buildHybridPrompt in generator.js.
    const customListEl = $('gls_custom_lenses_list');
    if (customListEl) {
        renderCustomLenses(customListEl);
        on($('gls_add_custom_lens'), 'click', () => {
            const lenses = S().customLenses || (S().customLenses = []);
            lenses.push({ id: _newLensId(), name: t('New lens'), prompt: '', active: true });
            renderCustomLenses(customListEl);
            _invalidateLanguageCache();
            saveSettings();
        });
    }

    bindNum('gls_max_footnotes', 'maxFootnotes');

    // Output language (footnote text language). Replaces the old
    // document.documentElement.lang heuristic. On change, wipe ALL prompt-style
    // caches so the next build re-derives getOutputLanguage / label tables.
    const olEl = $('gls_output_language');
    if (olEl) {
        olEl.value = S().outputLanguage || 'ru';
        on(olEl, 'change', () => {
            S().outputLanguage = olEl.value;
            clearPresetOnManualEdit();   // §6.1
            // Output language affects EVERY style (base prompt, examples locale,
            // {{OUTPUT_LANGUAGE}} in .md files), so wipe the whole prompt cache,
            // not just language:/hybrid: prefixes. See
            // 2026-07-02-glosses-anchor-count-language-design.md §3.
            for (const k of Object.keys(state.promptCache)) delete state.promptCache[k];
            saveSettings();
        });
    }

    // Display
    const dmEl = $('gls_display_mode');
    if (dmEl) {
        dmEl.value = S().displayMode;
        on(dmEl, 'change', () => {
            S().displayMode = dmEl.value;
            syncDisplayPreviews();
            // The mode shapes what's already rendered (markers' sup index, the
            // under-post block), not only future posts — re-inject every
            // message with a verified payload so on-screen posts switch shape
            // immediately instead of on their next render/swipe/edit.
            reapplyHighlightsAll();
            saveSettings();
        });
    }

    /**
     * Keep the Display-section snapshots in step with class-driven state.
     * Color/opacity/fonts/width ride :root custom properties (pure CSS live),
     * but the highlight style class, the popup-header toggle, and the
     * displayMode sup need the class swaps done here. Called from the three
     * owning handlers above/below and once at bind time.
     */
    function syncDisplayPreviews() {
        const markerPrev = $('gls_marker_preview');
        if (markerPrev) {
            markerPrev.classList.remove('gls-hl-background', 'gls-hl-underline', 'gls-hl-dotted');
            markerPrev.classList.add(`gls-hl-${S().highlightStyle || 'background'}`);
            // displayMode 'inline' renders markers without the sup index.
            markerPrev.classList.toggle('gls-preview-inline', S().displayMode === 'inline');
        }
        const popupPrev = $('gls_popup_preview');
        if (popupPrev) {
            // The static HTML ships only an empty header placeholder — build
            // it once from the shared popup-header builder (single source
            // with the real popup and the CSS-dialog twin).
            const placeholder = popupPrev.querySelector('[data-gls-preview-header]');
            if (placeholder) placeholder.replaceWith(buildPopupHeader({ preview: true }).header);
            popupPrev.classList.toggle('gls-popup-preview--no-header', S().popupShowHeader === false);
        }
    }
    syncDisplayPreviews();

    // Highlight color: custom HSV picker (hue ring + saturation/value sliders).
    // The popover is built once, appended to the trigger's row, and toggled by
    // the button. Live onChange writes the setting + repaints markers/previews;
    // sync() on open re-reads the authoritative S().highlightColor.
    const hcBtn = $('gls_highlight_color_btn');
    const hcSwatch = $('gls_highlight_color_swatch');
    const hcHex = $('gls_highlight_color_hex');
    if (hcBtn) {
        const refreshTrigger = () => {
            hcSwatch.style.background = S().highlightColor;
            hcHex.textContent = S().highlightColor;
        };
        refreshTrigger();

        const picker = buildColorPicker({
            getHex: () => S().highlightColor,
            onChange: (hex) => {
                S().highlightColor = hex;
                refreshTrigger();
                applyHighlightStyles();
                saveSettings();
            },
        });
        hcBtn.parentElement.appendChild(picker.el);
        const closePicker = () => { picker.el.hidden = true; };
        on(hcBtn, 'click', () => {
            const willOpen = picker.el.hidden;
            if (willOpen) picker.sync();
            picker.el.hidden = !willOpen;
        });
        // Outside click / Escape close. Routed through on() so unbind removes
        // them with everything else.
        on(document, 'pointerdown', (e) => {
            if (picker.el.hidden) return;
            if (picker.el.contains(e.target) || hcBtn.contains(e.target)) return;
            closePicker();
        });
        on(document, 'keydown', (e) => { if (e.key === 'Escape') closePicker(); });
    }

    const hoEl = $('gls_highlight_opacity');
    const hoVal = $('gls_highlight_opacity_val');
    if (hoEl) {
        hoEl.value = S().highlightOpacity;
        if (hoVal) hoVal.textContent = `${S().highlightOpacity}%`;
        on(hoEl, 'input', () => {
            S().highlightOpacity = parseInt(hoEl.value);
            if (hoVal) hoVal.textContent = `${S().highlightOpacity}%`;
            applyHighlightStyles();
            saveSettings();
        });
    }

    const hsEl = $('gls_highlight_style');
    if (hsEl) { hsEl.value = S().highlightStyle; on(hsEl, 'change', () => { S().highlightStyle = hsEl.value; applyHighlightStyles(); syncDisplayPreviews(); saveSettings(); }); }

    const ffEl = $('gls_font_family');
    if (ffEl) { ffEl.value = S().footnoteFontFamily; on(ffEl, 'change', () => { S().footnoteFontFamily = ffEl.value; applyHighlightStyles(); saveSettings(); }); }

    // Floating panel font pair — separate settings, same publishing path.
    const pffEl = $('gls_panel_font_family');
    if (pffEl) { pffEl.value = S().panelFontFamily || 'inherit'; on(pffEl, 'change', () => { S().panelFontFamily = pffEl.value; applyHighlightStyles(); saveSettings(); }); }

    // Font size slider (0.70–1.50em, step 0.05). The setting keeps the
    // historical "0.90em" string format; the slider speaks plain numbers and
    // the readout restores the two-decimal em form.
    const fsEl = $('gls_font_size');
    const fsVal = $('gls_font_size_val');
    if (fsEl) {
        fsEl.value = parseFloat(S().footnoteFontSize || '0.90em');
        if (fsVal) fsVal.textContent = `${parseFloat(fsEl.value).toFixed(2)}em`;
        on(fsEl, 'input', () => {
            S().footnoteFontSize = `${parseFloat(fsEl.value).toFixed(2)}em`;
            if (fsVal) fsVal.textContent = S().footnoteFontSize;
            applyHighlightStyles();
            saveSettings();
        });
    }

    // Floating panel font size slider — mirrors the popup one above.
    const pfsEl = $('gls_panel_font_size');
    const pfsVal = $('gls_panel_font_size_val');
    if (pfsEl) {
        pfsEl.value = parseFloat(S().panelFontSize || '0.90em');
        if (pfsVal) pfsVal.textContent = `${parseFloat(pfsEl.value).toFixed(2)}em`;
        on(pfsEl, 'input', () => {
            S().panelFontSize = `${parseFloat(pfsEl.value).toFixed(2)}em`;
            if (pfsVal) pfsVal.textContent = S().panelFontSize;
            applyHighlightStyles();
            saveSettings();
        });
    }

    on($('gls_marker_size'), 'change', function () { S().markerFontSize = this.value; applyHighlightStyles(); saveSettings(); });

    // Compact panel rows: clamp each footnote body to two lines, click a row
    // to expand. The class rides #gls-panel-body, so a toggle restyles the
    // open panel immediately (the next render re-asserts it anyway).
    const pcCb = $('gls_panel_compact');
    if (pcCb) {
        pcCb.checked = S().panelCompactRows === true;
        on(pcCb, 'change', () => {
            S().panelCompactRows = pcCb.checked;
            document.getElementById('gls-panel-body')?.classList.toggle('gls-panel--compact', pcCb.checked);
            panelInvalidate();
            updatePanel();
            saveSettings();
        });
    }

    // Popup placement preference - read at positionPopup time (every open).
    const ppEl = $('gls_popup_position');
    if (ppEl) { ppEl.value = S().popupPosition || 'auto'; on(ppEl, 'change', () => { S().popupPosition = ppEl.value; saveSettings(); }); }

    // Launcher mode - ensureLauncher() mounts/unmounts both launchers (bar
    // button + FAB) to match the new mode immediately.
    const lmEl = $('gls_launcher_mode');
    if (lmEl) { lmEl.value = S().launcherMode || 'bar'; on(lmEl, 'change', () => { S().launcherMode = lmEl.value; saveSettings(); ensureLauncher(); }); }

    // Popup width slider - applyHighlightStyles republishes --gls-popup-maxw,
    // and the next showPopup positions against whatever width that yields.
    const pwEl = $('gls_popup_width');
    const pwVal = $('gls_popup_width_val');
    if (pwEl) {
        pwEl.value = S().popupMaxWidth;
        if (pwVal) pwVal.textContent = `${S().popupMaxWidth}px`;
        on(pwEl, 'input', () => {
            S().popupMaxWidth = parseInt(pwEl.value);
            if (pwVal) pwVal.textContent = `${S().popupMaxWidth}px`;
            applyHighlightStyles();
            saveSettings();
        });
    }

    // Popup skin + knobs. Everything publishes through applyHighlightStyles
    // (:root classes + the radius var), which restyles the live popup on its
    // next open AND the snapshot immediately — no syncDisplayPreviews needed.
    const ptEl = $('gls_popup_theme');
    if (ptEl) {
        ptEl.value = S().popupTheme || 'adaptive';
        on(ptEl, 'change', () => { S().popupTheme = ptEl.value; applyHighlightStyles(); saveSettings(); });
        // Palette chips under the select: one per skin, painted with that
        // skin's real computed colors; a click routes through this select's
        // change event, so apply/persist stays on the single path above.
        // The gallery's own sync listener rides `on` — same abort signal as
        // every other binding here, so unbind detaches it too. Insertion
        // guards the classic API — the unit tests' fake DOM has neither
        // Element.closest nor Element.after.
        const gallery = buildSkinGallery(ptEl, { on });
        const group = typeof ptEl.closest === 'function' ? ptEl.closest('.gls-s-field-group') : null;
        if (group && typeof group.after === 'function') {
            group.after(gallery);
        } else if (ptEl.parentNode && typeof ptEl.parentNode.insertBefore === 'function') {
            ptEl.parentNode.insertBefore(gallery, ptEl.nextSibling ?? null);
        }
    }

    const pdEl = $('gls_popup_density');
    if (pdEl) { pdEl.value = S().popupDensity || 'comfortable'; on(pdEl, 'change', () => { S().popupDensity = pdEl.value; applyHighlightStyles(); saveSettings(); }); }

    const pshEl = $('gls_popup_shadow');
    if (pshEl) { pshEl.value = S().popupShadow || 'strong'; on(pshEl, 'change', () => { S().popupShadow = pshEl.value; applyHighlightStyles(); saveSettings(); }); }

    const pcEl = $('gls_popup_corner');
    const pcVal = $('gls_popup_corner_val');
    if (pcEl) {
        pcEl.value = parseInt(S().popupCornerRadius, 10);
        if (pcVal) pcVal.textContent = `${parseInt(pcEl.value, 10)}px`;
        on(pcEl, 'input', () => {
            S().popupCornerRadius = parseInt(pcEl.value, 10);
            if (pcVal) pcVal.textContent = `${S().popupCornerRadius}px`;
            applyHighlightStyles();
            saveSettings();
        });
    }

    // Popup custom CSS layer. The toggle republishes the <style> tags through
    // applyHighlightStyles (which calls applyCustomCss); Edit opens the dialog
    // editor. The status hint is written by applyCustomCss itself, so there is
    // nothing to sync here beyond the initial checkbox state.
    const ccsCb = $('gls_custom_css_enabled');
    if (ccsCb) {
        ccsCb.checked = S().customCssEnabled !== false;
        on(ccsCb, 'change', () => { S().customCssEnabled = ccsCb.checked; applyHighlightStyles(); saveSettings(); });
    }
    const ccsEdit = $('gls_custom_css_edit');
    if (ccsEdit) on(ccsEdit, 'click', () => openCssEditor());

    // Popup header toggle - read at showPopup time, so an already-open popup
    // keeps its chrome; the next open reflects the change. Also flips the
    // popup snapshot in the Display section.
    const phCb = $('gls_popup_header');
    if (phCb) {
        phCb.checked = S().popupShowHeader !== false;
        on(phCb, 'change', () => { S().popupShowHeader = phCb.checked; syncDisplayPreviews(); saveSettings(); });
    }

    // Floating panel
    const fpCb = $('gls_floating_panel');
    if (fpCb) {
        fpCb.checked = S().floatingPanelEnabled;
        on(fpCb, 'change', () => {
            S().floatingPanelEnabled = fpCb.checked;
            // Master control: touching it clears any persisted ✕-hide so the
            // next enable starts with a visible panel.
            S().floatingPanelHidden = false;
            saveSettings();
            updatePanel();
            if (S().floatingPanelEnabled) initScrollObserver();
            // Refresh the 📖 launcher active state so it matches the checkbox.
            ensureLauncher();
        });
    }

    // Behavior
    bindCb('gls_auto_generate', 'autoGenerate');
    // Gloss user posts (manual-only): toggling mounts/unmounts the per-message
    // regen button + cached highlights on {{user}} posts. AI posts are never
    // touched. OFF -> strip user-post chrome; ON -> restoreHighlightsAll picks
    // up user posts too (gated guard in renderer.js).
    bindCb('gls_gloss_user', 'glossUserMessages', () => {
        // The scroll observer + panel's annotatable-id list both memoize on
        // this flag — re-derive them or user posts stay invisible to the
        // panel until the next chat switch.
        invalidateAiMsgCache();
        if (S().glossUserMessages) {
            restoreHighlightsAll();
        } else {
            document.querySelectorAll('.mes[is_user="true"]').forEach(el => {
                removeHighlights(el);
                el.querySelectorAll('.gls-regen-btn').forEach(b => b.remove());
            });
        }
        if (S().floatingPanelEnabled) initScrollObserver();
        updatePanel();
    });
    on($('gls_stop_words'), 'input', function () { S().stopWords = this.value; saveSettings(); });
    if ($('gls_stop_words')) $('gls_stop_words').value = S().stopWords;

    // Sound
    bindCb('gls_sound_enabled', 'soundEnabled');
    const svEl = $('gls_sound_volume');
    const svVal = $('gls_sound_volume_val');
    if (svEl) {
        svEl.value = S().soundVolume;
        if (svVal) svVal.textContent = `${S().soundVolume}%`;
        on(svEl, 'input', () => {
            S().soundVolume = parseInt(svEl.value);
            if (svVal) svVal.textContent = `${S().soundVolume}%`;
            saveSettings();
        });
    }

    const soundSel = $('gls_sound_select');
    const soundResetBtn = $('gls_sound_reset');
    const soundFileEl = $('gls_sound_file');

    // The Remove button only applies to a SERVER-side custom_<n> selection.
    function refreshSoundReset() {
        if (soundResetBtn) soundResetBtn.style.display = isCustomSoundId(resolveSoundId()) ? '' : 'none';
    }

    populateSoundSelect(soundSel);
    refreshSoundReset();

    on(soundSel, 'change', () => { S().soundId = soundSel.value; invalidateSoundCache(); refreshSoundReset(); saveSettings(); });

    // Upload → server-side per-user file store (travels with the ST data dir,
    // works on any device of the user). settings.json keeps only metadata.
    on(soundFileEl, 'change', async () => {
        const file = soundFileEl.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('read failed'));
                reader.readAsDataURL(file);
            });
            const parsed = parseDataUrl(dataUrl);
            const ext = parsed?.ext || file.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'wav';
            const key = nextCustomKey(S().soundFiles);
            const stored = glsSoundFileName(key, ext);
            await uploadUserFile(stored, parsed ? parsed.base64 : String(dataUrl).split(',')[1] || '');
            S().soundFiles = normalizeSoundFiles({ ...S().soundFiles, [key]: { name: file.name, file: stored } });
            S().soundId = key;
            invalidateSoundCache();
            populateSoundSelect(soundSel);
            soundSel.value = key;
            refreshSoundReset();
            saveSettings();
        } catch (e) {
            warn('Glosses: custom sound upload failed:', e);
            try { notifyUser('error', t('Could not upload the custom sound.'), 'gls-sound-upload'); } catch { /* non-fatal */ }
        }
        soundFileEl.value = '';
    });

    on(soundResetBtn, 'click', async () => {
        const key = resolveSoundId();
        if (!isCustomSoundId(key)) return;
        await deleteCustomSound(key);
        invalidateSoundCache();
        populateSoundSelect(soundSel);
        refreshSoundReset();
        saveSettings();
    });

    on($('gls_sound_test'), 'click', () => playSound());

    // Context
    bindNum('gls_context_depth', 'contextDepth');
    bindCb('gls_inc_card', 'includeCharacterCard');
    bindCb('gls_inc_persona', 'includePersona');
    bindCb('gls_inc_wi', 'includeLorebook');

    // Per-chat lorebook context (chatMetadata.gls_lorebook). The controls read
    // from chat METADATA, not from the global settings object, and re-sync on
    // every chat change.
    const loreEnabledCb = $('gls_lore_enabled');
    const loreModeSel = $('gls_lore_mode');
    function syncLoreControls() {
        const cfg = getChatLoreConfig();
        if (loreEnabledCb) loreEnabledCb.checked = cfg.enabled;
        if (loreModeSel) loreModeSel.value = cfg.autoScope ?? 'all';
    }
    if (loreEnabledCb) on(loreEnabledCb, 'change', () => {
        saveChatLoreConfig({ ...getChatLoreConfig(), enabled: loreEnabledCb.checked });
    });
    if (loreModeSel) on(loreModeSel, 'change', () => {
        saveChatLoreConfig({ ...getChatLoreConfig(), autoScope: loreModeSel.value === 'attached' ? 'attached' : undefined });
    });
    syncLoreControls();
    if (!_loreChatHook) {
        _loreChatHook = true;
        const ctx0 = getCtx();
        try {
            ctx0.eventSource?.on(ctx0.eventTypes?.CHAT_CHANGED, () => syncLoreControls());
        } catch { /* non-fatal: controls stay at bind-time values */ }
    }

    updateSrcPanels();
    populateProfiles();
}

export function unbindSettingsUI() {
    // Abort removes every listener bound through on() since the last bind —
    // the AbortController's signal was threaded into each addEventListener.
    // Reset the flag so a re-enable can bind a fresh controller.
    if (_settingsAbort) { _settingsAbort.abort(); _settingsAbort = null; }
    _settingsBound = false;
}

function bindCb(id, key, onChange) {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!S()[key];
    on(el, 'change', () => { S()[key] = el.checked; saveSettings(); onChange?.(); });
}

function bindNum(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = S()[key] ?? 0;
    const apply = () => { const n = parseFloat(el.value); if (Number.isFinite(n)) { S()[key] = n; saveSettings(); } };
    on(el, 'input', apply);
    on(el, 'change', apply);
}

export function updateSrcPanels() {
    const profEl = document.getElementById('gls_panel_profile');
    const custEl = document.getElementById('gls_panel_custom');
    if (profEl) profEl.hidden = S().source !== 'profile';
    if (custEl) custEl.hidden = S().source !== 'custom';
    if (S().source === 'profile') {
        populateProfiles().catch(() => {});
        updateProfileModelInfo();
    } else if (S().source === 'custom') {
        syncCustomApiKeyField();
        refreshHttpConfirm();
    }
}

// ── Insecure-endpoint confirmation (plan stage 8, UI half) ──
// The policy layer (endpoint-policy.js + connection.js) refuses plain HTTP on
// non-loopback hosts until the origin is confirmed. These functions are the
// settings-surface half of that flow: a hint + confirm button inside the
// Custom panel while the endpoint is an unconfirmed insecure-http URL, and an
// informational hint for loopback http (allowed, but not encrypted).

function httpConfirmEls() {
    return {
        group: document.getElementById('gls_http_confirm_group'),
        text: document.getElementById('gls_http_confirm_text'),
        btn: document.getElementById('gls_http_confirm_btn'),
    };
}

function refreshHttpConfirm() {
    const { group, text } = httpConfirmEls();
    if (!group || !text) return;
    if (S().source !== 'custom') { group.hidden = true; return; }
    const verdict = classifyEndpoint(S().customEndpoint);
    if (!verdict.ok) { group.hidden = true; return; }
    if (verdict.kind === 'insecure-http'
        && !isOriginAllowed(verdict.normalized, S().customEndpointAllowlist || [])) {
        let host = verdict.host;
        try { host = new URL(verdict.normalized).host || verdict.host; } catch { /* keep raw host */ }
        text.textContent = `${t('This endpoint uses plain HTTP outside localhost. Confirm the origin to allow requests — the API key will be sent unencrypted.')} [${host}]`;
        group.hidden = false;
        return;
    }
    if (verdict.kind === 'loopback-http') {
        text.textContent = t('Local HTTP endpoint (localhost) — requests are allowed, but the key is not encrypted.');
        group.hidden = false;
        return;
    }
    group.hidden = true;
}

function bindHttpConfirm() {
    const { btn } = httpConfirmEls();
    refreshHttpConfirm();
    if (!btn || btn.dataset.glsHttpConfirmBound === '1') return;
    // Plain listener (not the bind-scoped `on()`): the settings DOM is
    // recreated on every enable, so the element lifetime bounds the listener.
    btn.dataset.glsHttpConfirmBound = '1';
    btn.addEventListener('click', async () => {
        const verdict = classifyEndpoint(S().customEndpoint);
        if (!verdict.ok || verdict.kind !== 'insecure-http') { refreshHttpConfirm(); return; }
        const res = await confirmInsecureEndpoint(verdict.normalized, S().customEndpointAllowlist || []);
        if (res.ok) {
            try { notifyUser('success', t('Endpoint origin confirmed.'), 'gls-http-confirm'); } catch { /* non-fatal */ }
        } else {
            warn('Endpoint confirmation failed:', res.reason);
        }
        refreshHttpConfirm();
    });
}

export function updatePromptPanels() {
    const cw = document.getElementById('gls_custom_prompt_wrap');
    if (cw) cw.hidden = S().promptStyle !== 'custom';
    // The Language + CEFR selectors (gls_language_panel) are shown for the
    // standalone 'language' style AND for 'hybrid' when its Language lens is on.
    const lp = document.getElementById('gls_language_panel');
    const showLang = S().promptStyle === 'language'
        || (S().promptStyle === 'hybrid' && S().hybridLenses?.language);
    if (lp) lp.hidden = !showLang;
    const hp = document.getElementById('gls_hybrid_panel');
    if (hp) hp.hidden = S().promptStyle !== 'hybrid';
}

/** Reflect the active source button as pressed in the segmented picker. */
export function syncSegSource() {
    const src = S().source || 'default';
    document.querySelectorAll('#gls_source [data-gls-src]').forEach(b => {
        const active = b.dataset.glsSrc === src;
        b.classList.toggle('gls-s-seg-active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}

let _modelInfoReq = 0;
/** Show "<API> · <model>" under the selected profile (race-guarded). */
export function updateProfileModelInfo() {
    const info = document.getElementById('gls_profile_info');
    const txt  = document.getElementById('gls_profile_model');
    if (!info || !txt) return;
    const req = ++_modelInfoReq;
    txt.textContent = '';
    if (S().source !== 'profile' || !S().selectedProfile) {
        info.hidden = true;
        return;
    }
    getProfileDetails(S().selectedProfile).then(d => {
        if (req !== _modelInfoReq) return;
        if (!d) { info.hidden = true; return; }
        const parts = [];
        const api = d.api || '';
        if (api) parts.push(String(api).toUpperCase());
        const model = d.model || d.modelName || d.model_name || d.settings?.model || '';
        if (model) parts.push(String(model));
        if (!parts.length && d.name) parts.push(d.name);
        txt.textContent = parts.length ? parts.join(' · ') : t('Profile selected (no model data)');
        info.hidden = false;
    }).catch(() => { if (req === _modelInfoReq) info.hidden = true; });
}

/** Load the localforage-backed API key into the password field. */
function syncCustomApiKeyField(el) {
    const input = el || document.getElementById('gls_custom_apikey');
    if (!input) return;
    getApiKey().then(key => { input.value = key || ''; }).catch(() => {});
}

export async function populateProfiles() {
    const sel = document.getElementById('gls_profile_select');
    if (!sel) return;
    sel.innerHTML = `<option value="">${t('-- Select Profile --')}</option>`;
    try {
        const profiles = await getProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            sel.appendChild(opt);
        }
        if (S().selectedProfile && profiles.some(p => p.id === S().selectedProfile || p.name === S().selectedProfile)) {
            sel.value = S().selectedProfile;
        } else {
            if (S().selectedProfile) { S().selectedProfile = ''; saveSettings(); }
            sel.value = '';
        }
    } catch { /* profiles unavailable */ }
}

/** Drop cached language- and hybrid-style prompts so a target-language /
 *  CEFR / lens-toggle change applies. Hybrid's cache key embeds the lens
 *  signature AND the lang/cefr signature (via langCacheKey), so the same
 *  invalidation hook covers both. */
function _invalidateLanguageCache() {
    for (const k of Object.keys(state.promptCache)) {
        if (k.startsWith('language:') || k.startsWith('hybrid:')) delete state.promptCache[k];
    }
}

// ── Custom hybrid lenses ────────────────────────────────────────────────────
// Each row: [✓ active] [name input] [edit ✎ toggles textarea] [delete ✕].
// A custom lens contributes "### Lens: <name>\n<prompt>" to the assembled
// hybrid prompt (see _buildHybridPrompt). {{OUTPUT_LANGUAGE}} is the only
// token substituted inside the prompt body — no {{TARGET_LANG_*}}/{{CEFR_*}}.

function _newLensId() {
    try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
    return 'cl' + Date.now().toString(36);
}

function _mutateCustomLens(fn) {
    if (!Array.isArray(S().customLenses)) S().customLenses = [];
    fn(S().customLenses);
    _invalidateLanguageCache();
    saveSettings();
}

function renderCustomLenses(listEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const lenses = S().customLenses || [];
    if (!lenses.length) {
        const empty = document.createElement('div');
        empty.className = 'gls-s-custom-lenses-empty';
        empty.textContent = t('No custom lenses yet.');
        listEl.appendChild(empty);
        return;
    }

    lenses.forEach((c, i) => {
        const row = document.createElement('div');
        row.className = 'gls-s-custom-lens-row';

        // Active checkbox (toggle without save-others)
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'checkbox';
        cb.checked = !!c.active;
        cb.title = t('Enable');
        on(cb, 'change', () => _mutateCustomLens(arr => { arr[i].active = cb.checked; }));

        // Name input
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'text_pole gls-s-grow';
        nameInput.value = c.name || '';
        nameInput.placeholder = t('Lens name');
        on(nameInput, 'input', () => _mutateCustomLens(arr => { arr[i].name = nameInput.value; }));

        // Edit button (toggles the textarea below the row)
        const editBtn = document.createElement('div');
        editBtn.className = 'menu_button menu_button_icon';
        editBtn.title = t('Edit prompt');
        editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';

        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'gls-s-custom-lens-prompt';
        bodyWrap.hidden = true;
        const body = document.createElement('textarea');
        body.className = 'text_pole gls-s-resize-v';
        body.rows = 4;
        body.value = c.prompt || '';
        body.placeholder = t('Voice + when to footnote + label + format. Supports {{OUTPUT_LANGUAGE}}.');
        on(body, 'input', () => _mutateCustomLens(arr => { arr[i].prompt = body.value; }));
        bodyWrap.appendChild(body);

        on(editBtn, 'click', () => {
            const open = bodyWrap.hidden;
            bodyWrap.hidden = !open;
            if (open) body.focus();
        });

        // Delete button
        const delBtn = document.createElement('div');
        delBtn.className = 'menu_button menu_button_icon';
        delBtn.title = t('Delete');
        delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        on(delBtn, 'click', () => {
            _mutateCustomLens(arr => { arr.splice(i, 1); });
            renderCustomLenses(listEl);
        });

        const controls = document.createElement('div');
        controls.className = 'gls-s-custom-lens-row-controls';
        controls.appendChild(nameInput);
        controls.appendChild(editBtn);
        controls.appendChild(delBtn);

        row.appendChild(cb);
        row.appendChild(controls);
        row.appendChild(bodyWrap);
        listEl.appendChild(row);
    });
}
