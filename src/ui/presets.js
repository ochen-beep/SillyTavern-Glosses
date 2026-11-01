// @ts-check
/**
 * Glosses — Prompt presets (§6.1): one-click style+language bundles.
 *
 * Extracted verbatim from settings-sync.js (R-7.5 module split). setPreset
 * receives the settings panel's cache-invalidation and panel-visibility hooks
 * — presets.js has no settings-sync import, so no cycle exists.
 */

import { S, saveSettings, t } from '../core.js';


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
const PRESETS = {
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
export function setPreset(key, { invalidateLanguageCache, updatePromptPanels }) {
    const preset = PRESETS[key];
    if (!preset) return;
    const s = S();
    for (const [k, v] of Object.entries(preset)) {
        s[k] = v;
    }
    s.selectedPreset = key;
    saveSettings();
    // Re-sync every downstream control the preset touched so the dropdowns +
    // checkboxes reflect the merged state (not a stale prior render).
    invalidateLanguageCache();
    updatePromptPanels();
    updatePresetShowing();
}

/** Sync the visible settings controls DOWN to current S() after a preset
 *  apply (or after loadSettings rehydrates a stored selectedPreset on init).
 *  Touches: prompt style, output lang, target lang, CEFR, and the 6 hybrid
 *  lens checkboxes. No-ops for elements that aren't present. */
export function updatePresetShowing() {
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
export function clearPresetOnManualEdit() {
    if (S().selectedPreset) {
        S().selectedPreset = '';
        saveSettings();
        const sel = document.getElementById('gls_preset');
        if (sel) sel.value = '';
    }
}
