import { test } from 'node:test';
import assert from 'node:assert/strict';

// §5.3 spec test: resolveActiveLenses contract, tested against the REAL
// generator.js implementation via the NODE_TEST-gated _test export. (The
// previous version of this file mirrored the function body 1:1 — it passed
// for the wrong reason once the real implementation drifted.)

import './helpers/stub-runtime.mjs';
import { DEFAULT_SETTINGS } from '../src/core.js';
import { _test } from '../src/generator.js';

const { resolveActiveLenses } = _test;
const DEFAULT_HYBRID_LENSSES = DEFAULT_SETTINGS.hybridLenses;

test('resolveActiveLenses backfills defaults for missing/typed-wrong keys', () => {
    const defaults = DEFAULT_HYBRID_LENSSES;
    // Hand-edit blob missing `academic`/`expansion` and a wrongly-typed `meta`.
    const lenses = { language: false, pratchett: true, canon: 'on', meta: 1 };
    const out = resolveActiveLenses(lenses, defaults);
    assert.deepEqual(out, {
        language: false,    // explicit
        pratchett: true,    // explicit
        canon: true,        // 'on' is not boolean → default true
        academic: false,    // missing → default false
        meta: false,        // 1 is not boolean → default false
        expansion: false,   // missing → default false
    });
});

test('resolveActiveLenses handles null/undefined lenses gracefully', () => {
    assert.deepEqual(resolveActiveLenses(null, DEFAULT_HYBRID_LENSSES), DEFAULT_HYBRID_LENSSES);
    assert.deepEqual(resolveActiveLenses(undefined, DEFAULT_HYBRID_LENSSES), DEFAULT_HYBRID_LENSSES);
    assert.deepEqual(resolveActiveLenses({}, DEFAULT_HYBRID_LENSSES), DEFAULT_HYBRID_LENSSES);
});

test('resolveActiveLenses respects explicit false booleans', () => {
    const lenses = { language: false, pratchett: false, canon: false, academic: false, meta: false, expansion: false };
    assert.deepEqual(resolveActiveLenses(lenses, DEFAULT_HYBRID_LENSSES), lenses);
});
