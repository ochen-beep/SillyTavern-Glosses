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
    state, S, saveSettings, t, setApiKey, notifyUser, warn, getCtx,
} from '../core.js';
import { generationCoordinator } from '../application/generation-coordinator.js';
import { removeHighlights, restoreHighlightsAll, reapplyHighlightsAll } from '../renderer.js';
import { closePopup } from './footnote-popup.js';
import { applyHighlightStyles } from './highlight-styles.js';
import { updatePanel, invalidateAiMsgCache, panelInvalidate } from './window.js';
import { buildPopupHeader } from './popup-header.js';
import { buildSkinGallery } from './skin-gallery.js';
import { ensureLauncher } from './launcher.js';
import { initScrollObserver } from '../events.js';
import {
    populateSoundSelect, playSound,
    isCustomSoundId, resolveSoundId, nextCustomKey, glsSoundFileName,
    normalizeSoundFiles, deleteCustomSound, parseDataUrl,
} from '../sound.js';
import { uploadUserFile } from '../user-files.js';
import { getChatLoreConfig, saveChatLoreConfig } from '../lorebooks.js';
import { createLorebookPicker } from './lorebook-picker.js';
import { buildColorPicker } from './color-picker.js';
import { openCssEditor } from './custom-css.js';
import { setPreset, clearPresetOnManualEdit } from './presets.js';
import { createBinders } from './setting-binders.js';
import { setupLensEditor } from './lens-editor.js';
import {
    bindHttpConfirm, refreshHttpConfirm, updateProfileModelInfo,
    syncCustomApiKeyField, populateProfiles,
} from './connection-settings.js';

let _settingsBound = false;
// CHAT_CHANGED hook for the per-chat lore controls: bound once for the page
// lifetime (the settings DOM persists across bind/unbind, and the listener is
// intentionally NOT routed through the bind-scoped AbortController — it must
// re-sync after every re-enable). The picker itself is re-created on every
// bind (the settings DOM is rebuilt on disable→enable).
/** @type {(() => void) | null} CHAT_CHANGED → picker refresh; removed on unbind. */
let _loreChatHandler = null;
/** @type {ReturnType<import('./lorebook-picker.js').createLorebookPicker> | null} */
let _lorePicker = null;
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
    // Don't latch the flag when the settings DOM isn't there: a failed first
    // template load (init() warns and continues) would otherwise leave the
    // panel permanently unbound once it does load — every toggle clickable,
    // none of them reaching S().
    if (!document.getElementById('gls_settings_container')) return;
    _settingsBound = true;
    _settingsAbort = new AbortController();
    const $ = id => document.getElementById(id);
    const { bindCb, bindNum, bindSlider, bindSelect, bindText } = createBinders(on);

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

    // Master toggle
    bindCb('gls_enabled', 'enabled', () => {
        if (!S().enabled) {
            document.querySelectorAll('.mes[mesid]').forEach(el => removeHighlights(el));
            // Regen buttons carry their own click listeners; the soft-disable
            // must remove them or they keep generating while "off".
            document.querySelectorAll('.gls-regen-btn').forEach(btn => btn.remove());
        } else {
            restoreHighlightsAll();
        }
        applyHighlightStyles();
        // updatePanel() tears the floating panel down when disabled and rebuilds
        // it on re-enable (mirrors the floatingPanelEnabled reconciliation).
        updatePanel();
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
                clearPresetOnManualEdit();
                return;
            }
            await setPreset(key, { invalidateLanguageCache: _invalidateLanguageCache, updatePromptPanels });
        });
    }

    // Lens UI (built-in overrides + custom rows); the binders follow the
    // same AbortController the rest of the panel uses.
    setupLensEditor({ on, invalidateLanguageCache: _invalidateLanguageCache });

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
        let keyStatusTimer = 0;
        on(akEl, 'change', () => {
            // Tracked so syncCustomApiKeyField (a panel update can fire while
            // this write is still in flight) reads the store only after it
            // settles — otherwise the re-fill races the save and resurrects
            // the stale key.
            _apiKeySave = setApiKey(akEl.value)
                .then(() => {
                    // Visible "saved" feedback: the password mask hides the
                    // value, so a silent localforage write left no way to tell
                    // a committed key from one that never landed (the field is
                    // re-filled from the store by updateSrcPanels()).
                    const status = $('gls_apikey_status');
                    if (!status) return;
                    status.hidden = false;
                    status.textContent = t('Key saved');
                    clearTimeout(keyStatusTimer);
                    keyStatusTimer = setTimeout(() => { status.hidden = true; }, 4000);
                })
                .catch(() => {});
        });
        syncCustomApiKeyField(akEl);
    }

    // Prompt style
    bindSelect('gls_prompt_style', 'promptStyle',
        { onChange() { clearPresetOnManualEdit(); updatePromptPanels(); } });
    updatePromptPanels();

    bindText('gls_custom_prompt', 'customPrompt');

    // Language (for the 'language' prompt style)
    const tlEl = $('gls_target_language');
    if (tlEl) {
        // Localise <optgroup> labels — data-i18n no-ops on optgroup (it
        // renders from the `label` attribute, not textContent), so we set
        // `label` directly via t().
        tlEl.querySelectorAll('optgroup[data-gls-i18n-optgroup]').forEach(og => {
            og.label = t(og.dataset.glsI18nOptgroup);
        });
    }
    bindSelect('gls_target_language', 'targetLanguage',
        { onChange() { clearPresetOnManualEdit(); _invalidateLanguageCache(); } });
    bindSelect('gls_cefr_level', 'cefrLevel', { onChange() { clearPresetOnManualEdit(); _invalidateLanguageCache(); } });

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
    bindNum('gls_max_footnotes', 'maxFootnotes');

    // Auto footnote count: the checkbox hands count authority to the model.
    // The numeric input is DISABLED (not hidden) so the user sees what they
    // will return to when they untick it.
    const maxFnCountEl = $('gls_max_footnotes');
    function syncAutoCountInput() {
        if (maxFnCountEl) maxFnCountEl.disabled = S().autoFootnoteCount === true;
    }
    bindCb('gls_auto_footnote_count', 'autoFootnoteCount', syncAutoCountInput);
    syncAutoCountInput();

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
        // 'panel' mode force-enables the floating panel (it is the ONLY
        // footnote surface there). That side effect must not outlive the mode:
        // the pre-panel {enabled, hidden} pair is snapshotted on entry and
        // restored on exit, so leaving panel mode returns the panel to the
        // state the user's own actions left it in. Session-scope snapshot:
        // a bind that STARTS inside panel mode (reload / re-enable) has no
        // pre-state — the documented degradation is that the panel stays
        // enabled on exit (the mode forced it on at boot too).
        let _panelModePrev = null;
        on(dmEl, 'change', () => {
            const prevMode = S().displayMode;
            S().displayMode = dmEl.value;
            if (S().displayMode === 'panel' && prevMode !== 'panel') {
                _panelModePrev = { enabled: S().floatingPanelEnabled, hidden: S().floatingPanelHidden };
                S().floatingPanelEnabled = true;
                S().floatingPanelHidden = false;
            } else if (S().displayMode !== 'panel' && prevMode === 'panel') {
                if (_panelModePrev) {
                    S().floatingPanelEnabled = _panelModePrev.enabled;
                    S().floatingPanelHidden = _panelModePrev.hidden;
                }
                _panelModePrev = null;
            }
            // The checkbox always mirrors the live flags, both directions.
            const fpCbEl = $('gls_floating_panel');
            if (fpCbEl) fpCbEl.checked = S().floatingPanelEnabled;
            // An open popup is anchored to a marker that panel mode is about
            // to strip from the DOM — close it first.
            closePopup();
            syncDisplayPreviews();
            // The mode shapes what's already rendered (markers' sup index, the
            // under-post block), not only future posts — re-inject every
            // message with a verified payload so on-screen posts switch shape
            // immediately instead of on their next render/swipe/edit. In panel
            // mode injectHighlights early-returns after removeHighlights, so
            // the same call also strips markers on the way INTO panel mode.
            reapplyHighlightsAll();
            updatePanel();
            // Self-gating: arms the scroll-follow observer only when
            // displayMode==='panel' && floatingPanelEnabled; tears it down
            // otherwise.
            initScrollObserver();
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
            // displayMode 'panel' renders no markers at all — dim the preview
            // so the style controls below don't read as applicable.
            markerPrev.classList.toggle('gls-preview-disabled', S().displayMode === 'panel');
        }
        const popupPrev = $('gls_popup_preview');
        if (popupPrev) {
            // The static HTML ships only an empty header placeholder — build
            // it once from the shared popup-header builder (single source
            // with the real popup and the CSS-dialog twin).
            const placeholder = popupPrev.querySelector('[data-gls-preview-header]');
            if (placeholder) placeholder.replaceWith(buildPopupHeader({ preview: true }).header);
            popupPrev.classList.toggle('gls-popup-preview--no-header', S().popupShowHeader === false);
            popupPrev.classList.toggle('gls-preview-disabled', S().displayMode === 'panel');
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

    bindSlider('gls_highlight_opacity', 'gls_highlight_opacity_val', 'highlightOpacity',
        { readout: n => `${n}%`, publish: applyHighlightStyles });

    bindSelect('gls_highlight_style', 'highlightStyle', { onChange() { applyHighlightStyles(); syncDisplayPreviews(); } });

    bindSelect('gls_font_family', 'footnoteFontFamily', { onChange: applyHighlightStyles });

    // Floating panel font pair — separate settings, same publishing path.
    bindSelect('gls_panel_font_family', 'panelFontFamily', { fallback: 'inherit', onChange: applyHighlightStyles });

    // Font size slider (0.70–1.50em, step 0.05). The setting keeps the
    // historical "0.90em" string format; the slider speaks plain numbers and
    // the readout restores the two-decimal em form.
    bindSlider('gls_font_size', 'gls_font_size_val', 'footnoteFontSize', {
        toSlider: v => parseFloat(v || '0.90em'),
        toSetting: n => `${n.toFixed(2)}em`,
        readout: n => `${n.toFixed(2)}em`,
        publish: applyHighlightStyles,
    });

    // Floating panel font size slider — mirrors the popup one above.
    bindSlider('gls_panel_font_size', 'gls_panel_font_size_val', 'panelFontSize', {
        toSlider: v => parseFloat(v || '0.90em'),
        toSetting: n => `${n.toFixed(2)}em`,
        readout: n => `${n.toFixed(2)}em`,
        publish: applyHighlightStyles,
    });

    bindSelect('gls_marker_size', 'markerFontSize', { fallback: '0.75em', onChange: applyHighlightStyles });

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
    bindSelect('gls_popup_position', 'popupPosition', { fallback: 'auto' });

    // Launcher mode - ensureLauncher() mounts/unmounts both launchers (bar
    // button + FAB) to match the new mode immediately.
    bindSelect('gls_launcher_mode', 'launcherMode', { fallback: 'bar', onChange: ensureLauncher });

    // Popup width slider - applyHighlightStyles republishes --gls-popup-maxw,
    // and the next showPopup positions against whatever width that yields.
    bindSlider('gls_popup_width', 'gls_popup_width_val', 'popupMaxWidth', { readout: n => `${n}px`, publish: applyHighlightStyles });

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

    bindSelect('gls_popup_density', 'popupDensity', { fallback: 'comfortable', onChange: applyHighlightStyles });

    bindSelect('gls_popup_shadow', 'popupShadow', { fallback: 'strong', onChange: applyHighlightStyles });

    bindSlider('gls_popup_corner', 'gls_popup_corner_val', 'popupCornerRadius', { readout: n => `${n}px`, publish: applyHighlightStyles });

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
            // Self-gating both ways: arms the observer only when the panel is
            // on AND displayMode==='panel'; disconnects it otherwise.
            initScrollObserver();
            // Refresh the 📖 launcher active state so it matches the checkbox.
            ensureLauncher();
        });
    }

    // Behavior
    // Toggle-off aborts in-flight AUTO runs (manual regen runs keep going):
    // without this a run started seconds before the flip still committed its
    // footnotes, reading as "generation fired while auto-generate is off".
    bindCb('gls_auto_generate', 'autoGenerate', () => {
        if (!S().autoGenerate) generationCoordinator.abortAutoRuns();
    });
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
        initScrollObserver();
        updatePanel();
    });
    bindText('gls_stop_words', 'stopWords');

    // Sound
    bindCb('gls_sound_enabled', 'soundEnabled');
    bindSlider('gls_sound_volume', 'gls_sound_volume_val', 'soundVolume', { readout: n => `${n}%` });

    const soundSel = $('gls_sound_select');
    const soundResetBtn = $('gls_sound_reset');
    const soundFileEl = $('gls_sound_file');

    // The Remove button only applies to a SERVER-side custom_<n> selection.
    function refreshSoundReset() {
        if (soundResetBtn) soundResetBtn.style.display = isCustomSoundId(resolveSoundId()) ? '' : 'none';
    }

    populateSoundSelect(soundSel);
    refreshSoundReset();

    on(soundSel, 'change', () => { S().soundId = soundSel.value; refreshSoundReset(); saveSettings(); });

    // Upload → server-side per-user file store (travels with the ST data dir,
    // works on any device of the user). settings.json keeps only metadata.
    on(soundFileEl, 'change', async () => {
        const file = soundFileEl.files?.[0];
        if (!file) return;
        // S2: cap the upload — the data-URL read + base64 POST amplifies ~1.33×,
        // and a multi-hundred-MB file is not a sound-notification payload size.
        // The legacy-blob migration (sound.js) is NOT capped: it moves data the
        // user already has locally.
        const SOUND_UPLOAD_CAP_MB = 10;
        if (file.size > SOUND_UPLOAD_CAP_MB * 1024 * 1024) {
            try {
                notifyUser('error', t('The sound file is too large (max {0} MB).', SOUND_UPLOAD_CAP_MB), 'gls-sound-upload');
            } catch { /* non-fatal */ }
            soundFileEl.value = '';
            return;
        }
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

    // Per-chat lorebook context (chatMetadata.gls_lorebook). The picker owns
    // all lore controls (enable, auto/manual mode, scope, manual book/entry
    // selection) and reads from chat METADATA, not from the global settings
    // object. Re-created on every bind: the settings DOM is rebuilt on
    // disable→enable (old listeners die with the DOM; destroy() unsubscribes
    // the WORLDINFO_UPDATED hook on the shared eventSource).
    _lorePicker?.destroy();
    const loreRoot = document.getElementById('gls_lore_group');
    _lorePicker = loreRoot ? createLorebookPicker({
        root: loreRoot,
        getCtx,
        getConfig: () => getChatLoreConfig(),
        onChange: (cfg) => saveChatLoreConfig(cfg),
    }) : null;
    void _lorePicker?.refresh();
    if (!_loreChatHandler) {
        _loreChatHandler = () => { void _lorePicker?.refresh(); };
        const ctx0 = getCtx();
        try {
            ctx0.eventSource?.on(ctx0.eventTypes?.CHAT_CHANGED, _loreChatHandler);
        } catch { _loreChatHandler = null; /* non-fatal: controls stay at bind-time values */ }
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
    // The picker rides the shared eventSource (WORLDINFO_UPDATED) and mounts
    // its own DOM listeners — neither may outlive the settings DOM they render
    // into, or a disabled extension keeps refreshing into detached nodes.
    _lorePicker?.destroy();
    _lorePicker = null;
    if (_loreChatHandler) {
        try {
            const ctx0 = getCtx();
            ctx0?.eventSource?.removeListener?.(ctx0?.eventTypes?.CHAT_CHANGED, _loreChatHandler);
        } catch { /* host already torn down */ }
        _loreChatHandler = null;
    }
}


function updateSrcPanels() {
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


function updatePromptPanels() {
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
function syncSegSource() {
    const src = S().source || 'default';
    document.querySelectorAll('#gls_source [data-gls-src]').forEach(b => {
        const active = b.dataset.glsSrc === src;
        b.classList.toggle('gls-s-seg-active', active);
        b.setAttribute('aria-pressed', String(active));
    });
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

