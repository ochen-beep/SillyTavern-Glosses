// @ts-check
/**
 * Glosses — floating launcher (FAB) tests.
 *
 * Covers the pure helpers: default anchor positions (desktop vs mobile),
 * viewport clamping (including the ST top-bar inset — the bar paints above the
 * FAB's layer, so a position in the top strip must be pushed below it), and
 * restore-position validation. The localStorage payload
 * is untrusted — stale coordinates saved on a larger viewport must fall back to
 * the corner default, never strand the FAB off-screen or partially outside.
 *
 * The DOM/drag glue (ensureFloatingLauncher, Pointer Events, resize listener)
 * is intentionally not unit-tested — same policy as theme-sync's observer
 * glue. The z-index layering contract is locked here against style.css (the
 * DS Comments window-stacking test, folded into this file).
 */

import './helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { _test } from '../src/ui/floating-launcher.js';

const { defaultPosition, clampPosition, clampFabPosition, computeRestoredPosition, FAB_SIZE } = _test;

const VP = { width: 1920, height: 1080 };

// ── defaultPosition ──

test('defaultPosition anchors to the bottom-right corner (desktop)', () => {
    assert.deepEqual(defaultPosition(VP, FAB_SIZE, false), { left: 1920 - 36 - 20, top: 1080 - 36 - 80 });
});

test('defaultPosition clears the send form on mobile', () => {
    const vp = { width: 390, height: 844 };
    const pos = defaultPosition(vp, FAB_SIZE, true);
    assert.deepEqual(pos, { left: 390 - 36 - 16, top: 844 - 36 - 120 });
});

test('defaultPosition never goes negative on tiny viewports', () => {
    assert.deepEqual(defaultPosition({ width: 40, height: 40 }, FAB_SIZE, true), { left: 0, top: 0 });
});

// ── clampPosition ──

test('clampPosition keeps the FAB fully inside the viewport', () => {
    assert.deepEqual(clampPosition({ left: -50, top: 9999 }, VP, FAB_SIZE), { left: 0, top: 1080 - 36 });
    // in-range coordinates pass through untouched
    assert.deepEqual(clampPosition({ left: 100, top: 200 }, VP, FAB_SIZE), { left: 100, top: 200 });
});

// ── clampFabPosition (ST top-bar inset) ──

test('clampFabPosition pushes a parked FAB out from under the ST top bar', () => {
    // The bar (z-index 3005) paints over the FAB (2999): a position in the top
    // strip would make the button permanently unclickable.
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, 44), { left: 100, top: 44 });
});

test('clampFabPosition leaves positions below the top bar untouched', () => {
    assert.deepEqual(clampFabPosition({ left: 100, top: 200 }, VP, FAB_SIZE, 44), { left: 100, top: 200 });
    // no measurable bar (hidden/scrolled away) → plain viewport clamp
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, 0), { left: 100, top: 10 });
});

test('clampFabPosition still respects the viewport when the inset is huge', () => {
    assert.deepEqual(
        clampFabPosition({ left: 100, top: 10 }, { width: 1920, height: 60 }, FAB_SIZE, 44),
        { left: 100, top: 60 - 36 },
    );
});

// ── computeRestoredPosition ──

test('computeRestoredPosition accepts an in-viewport saved position', () => {
    const saved = { left: 500, top: 300 };
    assert.deepEqual(computeRestoredPosition(saved, VP, FAB_SIZE, false), saved);
});

test('computeRestoredPosition rejects coordinates stranded outside a smaller viewport', () => {
    // Saved on a 1920×1080 window, restored on 1280×720: the FAB would be
    // unreachable — must fall back to the corner default instead.
    const pos = computeRestoredPosition({ left: 1700, top: 900 }, { width: 1280, height: 720 }, FAB_SIZE, false);
    assert.deepEqual(pos, { left: 1280 - 36 - 20, top: 720 - 36 - 80 });
});

test('computeRestoredPosition rejects malformed payloads', () => {
    const fallback = defaultPosition(VP, FAB_SIZE, false);
    const badPayloads = [null, undefined, {}, { left: 'x', top: 5 }, { left: NaN, top: 10 }, { left: -1, top: 10 }];
    for (const bad of badPayloads) {
        assert.deepEqual(computeRestoredPosition(bad, VP, FAB_SIZE, false), fallback);
    }
});

// ── Layering contract (vs style.css) ──

test('.gls_fab layers above the panel, below ST chrome and the popup (FAB toggle contract)', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const rule = css.match(/\.gls_fab\s*\{([\s\S]*?)\n\}/);
    assert.ok(rule, '.gls_fab rule should exist');
    // 2999: clickable over the floating panel (2998) — the FAB is the panel's
    // toggle — but below ST's own chrome (left-nav drawer 3000, top bar 3005)
    // so it never blocks host settings, while the footnote popup (9000) and
    // ST's #dialogue_popup (9999) stay above it.
    assert.match(rule[1], /z-index:\s*2999;/, '.gls_fab should remain at z-index 2999');
    assert.match(rule[1], /position:\s*fixed;/, '.gls_fab should be viewport-fixed');
    assert.match(css, /\.gls_fab\.gls_fab_active\s*\{/, 'active FAB state rule should exist (never hides while the panel is open)');
});

test('.gls-panel stays one layer under the FAB it toggles', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const panel = css.match(/\.gls-panel\s*\{([\s\S]*?)\n\}/);
    assert.ok(panel, '.gls-panel rule should exist');
    assert.match(panel[1], /z-index:\s*2998;/, '.gls-panel should remain at z-index 2998 (under the FAB 2999, under ST chrome 3000+)');
});

test('generating pulse rules cover both launchers with a reduced-motion fallback', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    // generator.js toggles .gls_generating on #gls_launcher + #gls_fab (the DOM
    // glue itself is not unit-tested, so the class-name contract lives here).
    assert.match(css, /\.gls_launcher\.gls_generating/, 'bar launcher pulse rule should exist');
    assert.match(css, /\.gls_fab\.gls_generating/, 'FAB pulse rule should exist');
    assert.match(css, /@keyframes gls_pulse/, 'pulse keyframes should exist');
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.gls_fab\.gls_generating[\s\S]*?\n\}/);
    assert.ok(reduced, 'reduced-motion fallback for the generating pulse should exist');
});

// ── rectsIntersect (FAB↔panel-header passthrough, UX fix) ──
// The FAB paints above the panel (contract above). When a parked FAB overlaps
// the panel HEADER, syncFloatingLauncher() adds .gls_fab--passthrough so taps
// fall through to the header controls; the pure overlap test is locked here.

test('rectsIntersect: true only on real 2D overlap', () => {
    const { rectsIntersect } = _test;
    const header = { left: 969, top: 397, right: 1289, bottom: 440 };
    // FAB parked on the header (the reported papercut): overlaps on both axes.
    assert.equal(rectsIntersect({ left: 982, top: 382, right: 1018, bottom: 418 }, header), true);
    // FAB below the header: vertical ranges touch but do not overlap.
    assert.equal(rectsIntersect({ left: 982, top: 440, right: 1018, bottom: 476 }, header), false);
    // FAB left of the header.
    assert.equal(rectsIntersect({ left: 900, top: 382, right: 936, bottom: 418 }, header), false);
    // Edge-touching is NOT an overlap (strict comparisons).
    assert.equal(rectsIntersect({ left: 1289, top: 397, right: 1325, bottom: 433 }, header), false);
    // Null rects (missing panel/FAB) never "overlap".
    assert.equal(rectsIntersect(null, header), false);
    assert.equal(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, null), false);
});
