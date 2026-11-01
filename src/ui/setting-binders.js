// @ts-check
/**
 * Glosses — DOM↔state binding helpers for the settings panel.
 *
 * Extracted verbatim from settings-sync.js (R-7.5 module split). Every
 * listener routes through the caller's AbortController-scoped on() helper,
 * so unbindSettingsUI() aborts them all — createBinders(on) is called once
 * per bind with the live wrapper.
 */

import { S, saveSettings } from '../core.js';

/** Create the five binders bound to the given on() listener wrapper. */
export function createBinders(on) {
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
        // Honor the input's own min/max contract (settings.html declares it, e.g.
        // max footnotes 1–20, context depth 0–50). Native number validation only
        // styles/spinners — it never blocks a TYPED value, so without this clamp
        // out-of-range numbers persisted and showed in the field.
        const min = parseFloat(el.getAttribute?.('min'));
        const max = parseFloat(el.getAttribute?.('max'));
        const clamp = (n) => {
            if (Number.isFinite(min) && n < min) return min;
            if (Number.isFinite(max) && n > max) return max;
            return n;
        };
        const apply = () => {
            const n = parseFloat(el.value);
            if (Number.isFinite(n)) { S()[key] = clamp(n); saveSettings(); }
        };
        on(el, 'input', apply);
        on(el, 'change', () => {
            apply();
            // Normalize the visible field on commit (blur/Enter/spinner): a typed
            // 25 shows 20; empty/garbage restores the last good setting. Mid-typing
            // ('input') deliberately does NOT rewrite the field — fighting the caret.
            const n = parseFloat(el.value);
            el.value = String(Number.isFinite(n) ? clamp(n) : (S()[key] ?? ''));
        });
    }
    
    /** Slider + readout + persist. `toSlider`/`toSetting` map between the
     *  setting's stored shape (e.g. the "0.90em" string) and the slider's plain
     *  number; `readout(n)` renders the value span; `publish` refreshes the
     *  live surfaces before save (same order as the hand-written copies). */
    function bindSlider(id, valId, key, { toSlider, toSetting, readout, publish } = {}) {
        const el = document.getElementById(id);
        if (!el) return;
        const val = document.getElementById(valId);
        const initial = toSlider ? toSlider(S()[key]) : (S()[key] ?? 0);
        el.value = initial;
        const show = (n) => { if (val) val.textContent = readout ? readout(n) : `${n}`; };
        show(initial);
        on(el, 'input', () => {
            const n = parseFloat(el.value);
            S()[key] = toSetting ? toSetting(n) : n;
            show(n);
            publish?.();
            saveSettings();
        });
    }
    
    /** Select + persist. `fallback` mirrors the `|| fallback` inits; `onChange`
     *  runs after the setting is saved (live-surface refresh hooks). */
    function bindSelect(id, key, { fallback, onChange } = {}) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = S()[key] || fallback || '';
        on(el, 'change', () => { S()[key] = el.value; saveSettings(); onChange?.(); });
    }
    
    /** Text input + persist (no transform). */
    function bindText(id, key) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = S()[key] ?? '';
        on(el, 'input', () => { S()[key] = el.value; saveSettings(); });
    }
    return { bindCb, bindNum, bindSlider, bindSelect, bindText };
}
