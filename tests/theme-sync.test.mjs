import { test } from 'node:test';
import assert from 'node:assert/strict';

// core.js (imported transitively by theme-sync.js via `import { log, warn }`)
// calls `document.createElement('div')` at module-eval time. Load the DOM stub
// FIRST so the import chain evaluates under Node, mirroring parser.test.mjs.
import './helpers/stub-runtime.mjs';

import { forceOpaqueBg } from '../src/ui/theme-sync.js';

test('forceOpaqueBg: rgba() drops the alpha channel', () => {
    assert.equal(forceOpaqueBg('rgba(23, 30, 33, 0.61)'), 'rgb(23, 30, 33)');
    // Fractional alpha of 1 still collapses to opaque rgb().
    assert.equal(forceOpaqueBg('rgba(23, 23, 23, 1)'), 'rgb(23, 23, 23)');
});

test('forceOpaqueBg: rgb() (no alpha) passes through unchanged', () => {
    assert.equal(forceOpaqueBg('rgb(10, 20, 30)'), 'rgb(10, 20, 30)');
});

test('forceOpaqueBg: rgb()/rgba() tolerate extra whitespace', () => {
    assert.equal(forceOpaqueBg('rgba( 1 , 2 , 3 , 0.5 )'), 'rgb(1, 2, 3)');
});

test('forceOpaqueBg: 6- and 3-digit hex pass through (already opaque)', () => {
    assert.equal(forceOpaqueBg('#1e1e1e'), '#1e1e1e');
    assert.equal(forceOpaqueBg('#abc'), '#abc');
});

test('forceOpaqueBg: 8-digit hex strips the alpha pair', () => {
    assert.equal(forceOpaqueBg('#1e1e1eff'), '#1e1e1e');
    assert.equal(forceOpaqueBg('#1e1e1e00'), '#1e1e1e');
});

test('forceOpaqueBg: empty / null / whitespace yields the default fallback', () => {
    assert.equal(forceOpaqueBg(''), '#1e1e1e');
    assert.equal(forceOpaqueBg('   '), '#1e1e1e');
    assert.equal(forceOpaqueBg(null), '#1e1e1e');
});

test('forceOpaqueBg: unparseable input (named color, hsl) yields the fallback', () => {
    assert.equal(forceOpaqueBg('red'), '#1e1e1e');
    assert.equal(forceOpaqueBg('hsl(120, 100%, 50%)'), '#1e1e1e');
    assert.equal(forceOpaqueBg('not a color'), '#1e1e1e');
});

test('forceOpaqueBg: honors a custom fallback', () => {
    assert.equal(forceOpaqueBg('', '#2a2a2a'), '#2a2a2a');
    assert.equal(forceOpaqueBg(null, '#ffffff'), '#ffffff');
    assert.equal(forceOpaqueBg('garbage', '#2a2a2a'), '#2a2a2a');
    // A valid color is returned regardless of the fallback argument.
    assert.equal(forceOpaqueBg('rgba(5,6,7,0.2)', '#2a2a2a'), 'rgb(5, 6, 7)');
});
