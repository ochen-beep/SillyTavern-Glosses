// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Tests for two v3.2 popup-customization pieces:
//
// 1. deriveSurfaceColor (src/ui/theme-sync.js) — the floating-card surface
//    shifted one lightness step away from the chat background, so the popup
//    separates from same-hue themes (gray-on-gray blend) on ANY theme.
// 2. positionPopup (src/renderer.js) — side-aware vertical placement driven
//    by the popupPosition setting ('auto' / 'below' / 'above'), with the
//    flip-when-it-doesn't-fit rule.

// core.js (imported transitively) touches document at module-eval time; load
// the DOM stub FIRST (mirrors theme-sync.test.mjs).
import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { deriveSurfaceColor } from '../src/ui/theme-sync.js';
import { positionPopup } from '../src/renderer.js';
import { loadSettings, S } from '../src/core.js';

function freshSettingsContext() {
    resetCtx({ extensionSettings: { Glosses: {} } });
    loadSettings();
}

// ── deriveSurfaceColor ───────────────────────────────────────────────────────

test('deriveSurfaceColor: dark tint darkens (away from the chat bg)', () => {
    // rgb(60,60,60) is dark → surface moves toward black by the default 0.12.
    // 60 * (1 - 0.12) = 52.8 → 53.
    assert.equal(deriveSurfaceColor('rgb(60, 60, 60)'), 'rgb(53, 53, 53)');
});

test('deriveSurfaceColor: light tint lightens', () => {
    // rgb(200,200,200) is light → moves toward white: 200 + 55*0.12 = 206.6 → 207.
    assert.equal(deriveSurfaceColor('rgb(200, 200, 200)'), 'rgb(207, 207, 207)');
});

test('deriveSurfaceColor: hue is preserved, only lightness moves', () => {
    // Cappuccino-ish warm gray, dark → all channels shift by the same −0.12
    // step toward black, so the r>g>b relationship survives.
    const out = deriveSurfaceColor('rgb(94, 78, 64)');
    assert.equal(out, 'rgb(83, 69, 56)');
    const [r, g, b] = out.match(/\d+/g).map(Number);
    assert.ok(r > g && g > b, 'channel order preserved (warm hue intact)');
});

test('deriveSurfaceColor: colored tints (pink / blue) shift like grays', () => {
    // Dark-ish blue theme: darkens.
    assert.equal(deriveSurfaceColor('rgb(30, 34, 52)'), 'rgb(26, 30, 46)');
    // Light pink theme: lightens, stays pink.
    const pink = deriveSurfaceColor('rgb(244, 214, 220)');
    assert.equal(pink, 'rgb(245, 219, 224)');
});

test('deriveSurfaceColor: hex input parses like rgb()', () => {
    assert.equal(deriveSurfaceColor('#3c3c3c'), 'rgb(53, 53, 53)');
    assert.equal(deriveSurfaceColor('#c8c8c8'), 'rgb(207, 207, 207)');
});

test('deriveSurfaceColor: custom shift amount scales the step', () => {
    assert.equal(deriveSurfaceColor('rgb(60, 60, 60)', { shift: 0.5 }), 'rgb(30, 30, 30)');
    assert.equal(deriveSurfaceColor('rgb(60, 60, 60)', { shift: 0 }), 'rgb(60, 60, 60)');
});

test('deriveSurfaceColor: unparseable input yields null (caller keeps CSS fallback)', () => {
    assert.equal(deriveSurfaceColor(''), null);
    assert.equal(deriveSurfaceColor('not-a-color'), null);
    assert.equal(deriveSurfaceColor('hsl(120, 50%, 50%)'), null);
});

test('deriveSurfaceColor: threshold at mid luminance', () => {
    // rgb(128,128,128) luminance ≈ 0.216 < 0.5 → treated as dark → darkens.
    const mid = deriveSurfaceColor('rgb(128, 128, 128)');
    const [m] = mid.match(/\d+/g).map(Number);
    assert.ok(m < 128, 'mid-gray treated as dark (darkens)');
    // rgb(190,190,190) luminance ≈ 0.52 ≥ 0.5 → lightens.
    const hi = deriveSurfaceColor('rgb(190, 190, 190)');
    const [h] = hi.match(/\d+/g).map(Number);
    assert.ok(h > 190, 'light gray treated as light (lightens)');
});

// ── positionPopup ────────────────────────────────────────────────────────────

// The stub-runtime window shim has no viewport, and positionPopup reads
// window.innerWidth/innerHeight at call time — pin a desktop viewport.
globalThis.window.innerWidth = 1024;
globalThis.window.innerHeight = 768;

// Minimal fake elements: anchor carries a rect, popup measures itself.
function fakeAnchor(rect) {
    return { getBoundingClientRect: () => rect };
}
function fakePopup(w, h) {
    return {
        offsetWidth: w,
        offsetHeight: h,
        style: { left: '', top: '' },
    };
}

test('positionPopup: below when the marker sits high (auto)', () => {
    freshSettingsContext();
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 100, top: 80, bottom: 100 }));
    assert.equal(pos.top, 106); // rect.bottom 100 + gap 6
});

test('positionPopup: above when the marker sits low (auto)', () => {
    freshSettingsContext();
    // Viewport 1024x768 (stub). Marker near the bottom: below has ~68px,
    // above has ~700 → auto picks above.
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 100, top: 700, bottom: 720 }));
    assert.equal(pos.top, 700 - 160 - 6); // rect.top - popH - gap
});

test('positionPopup: preference "below" pins below when it fits, even though above is roomier', () => {
    freshSettingsContext();
    S().popupPosition = 'below';
    // Marker low but 178px below still hosts the 160px popup; auto would have
    // chosen above (550px free). The pin wins while the side fits.
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 100, top: 560, bottom: 580 }));
    assert.equal(pos.top, 586); // rect.bottom + gap
});

test('positionPopup: preference "below" flips up when below cannot fit', () => {
    freshSettingsContext();
    S().popupPosition = 'below';
    // Marker at the very bottom edge: below has 8px, above has ~700.
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 100, top: 720, bottom: 740 }));
    assert.equal(pos.top, 720 - 160 - 6);
});

test('positionPopup: preference "above" flips down when above cannot fit', () => {
    freshSettingsContext();
    S().popupPosition = 'above';
    // Marker near the top: above has ~40px, below has plenty.
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 100, top: 50, bottom: 70 }));
    assert.equal(pos.top, 76); // rect.bottom + gap
});

test('positionPopup: neither side fits → clamped to top margin, never off-screen', () => {
    freshSettingsContext();
    // Popup taller than the whole viewport: whatever the side math says, the
    // final top must be the margin, and the CSS (max-height 70vh + scroll)
    // keeps it usable.
    const pos = positionPopup(fakePopup(320, 900), fakeAnchor({ left: 100, top: 0, bottom: 20 }));
    assert.equal(pos.top, 10);
});

test('positionPopup: horizontal nudge keeps the popup inside the viewport', () => {
    freshSettingsContext();
    const pos = positionPopup(fakePopup(320, 160), fakeAnchor({ left: 950, top: 300, bottom: 320 }));
    assert.equal(pos.left, 1024 - 10 - 320);
    assert.ok(pos.left >= 10, 'never off-screen left');
});
