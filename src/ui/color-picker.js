// @ts-check
/**
 * Glosses — UI: HSV color picker (highlight color)
 *
 * A dependency-free picker for one hex color: a draggable HUE RING (conic
 * gradient donut with a live swatch in the hole) plus native range sliders
 * for SATURATION and VALUE. Opens as a small popover under the invoking
 * button; closes on outside click / Escape.
 *
 * Design notes:
 *  - Sliders are native <input type=range>: free keyboard/touch support and
 *    consistent thumbs; only the ring needs custom pointer math.
 *  - hsvToHex/hexToHsv are pure and exported for unit tests. The sliders'
 *    gradient endpoints are computed through the SAME pure functions, so the
 *    gradient can never disagree with the produced color.
 *  - No preset swatches by design (the user asked for full-range control).
 */

import { t } from '../core.js';

// ── Pure color math ──────────────────────────────────────────────────────────

/** Clamp + round an HSV channels object into canonical form. */
function normHsv({ h, s, v }) {
    return {
        h: ((h % 360) + 360) % 360,
        s: Math.min(100, Math.max(0, s)),
        v: Math.min(100, Math.max(0, v)),
    };
}

/**
 * HSV {h:0-360, s:0-100, v:0-100} → '#rrggbb'. Pure.
 * @returns {string} lowercase hex
 */
export function hsvToHex({ h, s, v }) {
    const { h: hh, s: ss, v: vv } = normHsv({ h, s, v });
    const c = (vv / 100) * (ss / 100);
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = (vv / 100) - c;
    let r = 0, g = 0, b = 0;
    if (hh < 60) [r, g, b] = [c, x, 0];
    else if (hh < 120) [r, g, b] = [x, c, 0];
    else if (hh < 180) [r, g, b] = [0, c, x];
    else if (hh < 240) [r, g, b] = [0, x, c];
    else if (hh < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const to2 = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * '#rgb' / '#rrggbb' → HSV {h,s,v}. Pure. Invalid input yields black
 * (hue normalized to 0 so the picker handles it without guards).
 * @returns {{ h: number, s: number, v: number }}
 */
export function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return { h: 0, s: 0, v: 0 };
    let hex6 = m[1];
    if (hex6.length === 3) hex6 = hex6.split('').map(c => c + c).join('');
    const r = parseInt(hex6.slice(0, 2), 16) / 255;
    const g = parseInt(hex6.slice(2, 4), 16) / 255;
    const b = parseInt(hex6.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    const s = max === 0 ? 0 : (d / max) * 100;
    return normHsv({ h, s, v: max * 100 });
}

// ── Picker component ─────────────────────────────────────────────────────────

const RING_PX = 148;      // outer diameter of the hue ring
const RING_THICK = 18;    // donut thickness; handle travels its middle

/**
 * Build the picker popover (not yet attached anywhere visible).
 *
 * @param {{ getHex: () => string, onChange: (hex: string) => void }} opts
 *   getHex supplies the current color each open (single source of truth is
 *   the caller's settings); onChange fires on every live change.
 * @returns {{ el: HTMLElement, sync: () => void }} el + a sync() to refresh
 *   from getHex() while open.
 */
export function buildColorPicker({ getHex, onChange }) {
    const el = document.createElement('div');
    el.className = 'gls-color-pop';
    el.setAttribute('role', 'dialog');
    el.hidden = true;

    // ── Hue ring ──
    // wrap (positioning + keyboard + hit area) → ring (the masked conic
    // donut — the ONLY masked node, so the swatch/handle siblings below stay
    // fully visible), swatch (live color in the hole), handle (hue cursor).
    const wrap = document.createElement('div');
    wrap.className = 'gls-hue-ring-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', t('Hue'));
    wrap.setAttribute('aria-valuemin', '0');
    wrap.setAttribute('aria-valuemax', '360');

    const ring = document.createElement('div');
    ring.className = 'gls-hue-ring';
    const swatch = document.createElement('div');
    swatch.className = 'gls-hue-swatch';
    const handle = document.createElement('div');
    handle.className = 'gls-hue-handle';
    handle.style.pointerEvents = 'none';
    wrap.append(ring, swatch, handle);

    // ── Sliders ──
    const mkSlider = (labelText, ariaKey) => {
        const row = document.createElement('label');
        row.className = 'gls-hue-row';
        const label = document.createElement('span');
        label.className = 'gls-hue-label';
        label.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.step = '1';
        input.setAttribute('aria-label', t(ariaKey));
        row.append(label, input);
        return { row, input };
    };
    const sSlider = mkSlider(t('Saturation'), 'Saturation');
    const vSlider = mkSlider(t('Value'), 'Value');

    // ── Hex readout ──
    const hexOut = document.createElement('div');
    hexOut.className = 'gls-color-hex-out';
    hexOut.setAttribute('aria-hidden', 'true');

    el.append(wrap, sSlider.row, vSlider.row, hexOut);

    let hsv = hexToHsv(getHex());

    /** Repaint every visual from `hsv` (no notification). */
    const paint = () => {
        const hex = hsvToHex(hsv);
        const rad = (hsv.h * Math.PI) / 180;
        const mid = RING_PX / 2;
        const r = mid - RING_THICK / 2;
        handle.style.left = `${Math.round(mid + r * Math.sin(rad))}px`;
        handle.style.top = `${Math.round(mid - r * Math.cos(rad))}px`;
        handle.style.background = hsvToHex({ h: hsv.h, s: 100, v: 100 });
        swatch.style.background = hex;
        wrap.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
        // Gradient endpoints go through the same pure conversion so the
        // tracks always preview the exact colors they will produce.
        sSlider.input.style.background =
            `linear-gradient(to right, ${hsvToHex({ h: hsv.h, s: 0, v: hsv.v })}, ${hsvToHex({ h: hsv.h, s: 100, v: hsv.v })})`;
        vSlider.input.style.background =
            `linear-gradient(to right, ${hsvToHex({ h: hsv.h, s: hsv.s, v: 0 })}, ${hsvToHex({ h: hsv.h, s: hsv.s, v: 100 })})`;
        sSlider.input.value = String(Math.round(hsv.s));
        vSlider.input.value = String(Math.round(hsv.v));
        hexOut.textContent = hex;
    };

    /** Paint + notify the caller. */
    const commit = () => { paint(); onChange(hsvToHex(hsv)); };

    // ── Ring drag: hue = angle from top, clockwise ──
    let dragging = false;
    const hueFromEvent = (e) => {
        const rect = wrap.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - cx;
        const y = (e.touches ? e.touches[0].clientY : e.clientY) - cy;
        const deg = (Math.atan2(x, -y) * 180) / Math.PI;
        hsv.h = ((deg % 360) + 360) % 360;
        commit();
    };
    wrap.addEventListener('pointerdown', (e) => {
        dragging = true;
        wrap.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        hueFromEvent(e);
    });
    wrap.addEventListener('pointermove', (e) => { if (dragging) hueFromEvent(e); });
    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        wrap.releasePointerCapture?.(e.pointerId);
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    // Keyboard: arrows rotate hue (Shift = coarse step).
    wrap.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 15 : 2;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { hsv.h -= step; commit(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { hsv.h += step; commit(); e.preventDefault(); }
    });

    sSlider.input.addEventListener('input', () => { hsv.s = Number(sSlider.input.value); commit(); });
    vSlider.input.addEventListener('input', () => { hsv.v = Number(vSlider.input.value); commit(); });

    return {
        el,
        /** Re-read the authoritative color (e.g. on open) without firing onChange. */
        sync() {
            hsv = hexToHsv(getHex());
            paint();
        },
    };
}
