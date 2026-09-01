// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure color math for the custom HSV picker (src/ui/color-picker.js):
// hsvToHex / hexToHsv drive the ring geometry, the slider gradients, and the
// committed setting — a rounding or branch bug here would desync the visible
// ring from the produced color, so the conversions are pinned by tests.

// core.js (imported transitively) touches document at module-eval time; load
// the DOM stub FIRST (mirrors theme-sync.test.mjs).
import './helpers/stub-runtime.mjs';
import { hsvToHex, hexToHsv } from '../src/ui/color-picker.js';

test('hsvToHex: primary / secondary hues land on exact channels', () => {
    assert.equal(hsvToHex({ h: 0, s: 100, v: 100 }), '#ff0000');
    assert.equal(hsvToHex({ h: 120, s: 100, v: 100 }), '#00ff00');
    assert.equal(hsvToHex({ h: 240, s: 100, v: 100 }), '#0000ff');
    assert.equal(hsvToHex({ h: 60, s: 100, v: 100 }), '#ffff00');
    assert.equal(hsvToHex({ h: 300, s: 100, v: 100 }), '#ff00ff');
});

test('hsvToHex: s=0 collapses to gray of the chosen value', () => {
    assert.equal(hsvToHex({ h: 123, s: 0, v: 100 }), '#ffffff');
    assert.equal(hsvToHex({ h: 123, s: 0, v: 0 }), '#000000');
    // v=51% → 130.05 → 130 = 0x82
    assert.equal(hsvToHex({ h: 0, s: 0, v: 51 }), '#828282');
});

test('hsvToHex: the default highlight color is reproduced exactly', () => {
    // core.js default highlightColor '#ffe066' — warm yellow.
    assert.equal(hsvToHex({ h: 48, s: 60, v: 100 }), '#ffe066');
});

test('hsvToHex: out-of-range channels normalize instead of clamping hue away', () => {
    assert.equal(hsvToHex({ h: 360, s: 100, v: 100 }), '#ff0000');   // h wraps to 0
    assert.equal(hsvToHex({ h: -300, s: 100, v: 100 }), '#ffff00');  // -300 → 60 → yellow
});

test('hsvToHex: negative hue wraps to its positive equivalent', () => {
    // -60 ≡ 300 → magenta
    assert.equal(hsvToHex({ h: -60, s: 100, v: 100 }), hsvToHex({ h: 300, s: 100, v: 100 }));
});

test('hexToHsv: primaries round back', () => {
    assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 100, v: 100 });
    assert.deepEqual(hexToHsv('#00ff00'), { h: 120, s: 100, v: 100 });
    assert.deepEqual(hexToHsv('#0000ff'), { h: 240, s: 100, v: 100 });
});

test('hexToHsv: black / white / gray have s=0 and stable hue 0', () => {
    assert.deepEqual(hexToHsv('#000000'), { h: 0, s: 0, v: 0 });
    assert.deepEqual(hexToHsv('#ffffff'), { h: 0, s: 0, v: 100 });
    // 0x82 = 130 → 130/255 = 50.98… (exact, not rounded).
    assert.deepEqual(hexToHsv('#828282'), { h: 0, s: 0, v: 130 / 255 * 100 });
});

test('hexToHsv: 3-digit hex expands', () => {
    assert.deepEqual(hexToHsv('#f00'), { h: 0, s: 100, v: 100 });
    assert.deepEqual(hexToHsv('#abc'), hexToHsv('#aabbcc'));
});

test('hexToHsv: tolerates missing # and case', () => {
    assert.deepEqual(hexToHsv('FF0000'), { h: 0, s: 100, v: 100 });
    assert.deepEqual(hexToHsv('#FfE066'), hexToHsv('#ffe066'));
});

test('hexToHsv: invalid input yields black, never throws', () => {
    assert.deepEqual(hexToHsv(''), { h: 0, s: 0, v: 0 });
    assert.deepEqual(hexToHsv('not-a-color'), { h: 0, s: 0, v: 0 });
    assert.deepEqual(hexToHsv('#12345'), { h: 0, s: 0, v: 0 });
});

test('roundtrip: hexToHsv → hsvToHex is identity for a spread of colors', () => {
    const samples = ['#ffe066', '#1e1e1e', '#d4a373', '#4a90d9', '#e63946', '#2a9d8f', '#f72585'];
    for (const hex of samples) {
        assert.equal(hsvToHex(hexToHsv(hex)), hex, `roundtrip failed for ${hex}`);
    }
});
