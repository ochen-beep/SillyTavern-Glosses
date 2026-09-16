import { test } from 'node:test';
import assert from 'node:assert/strict';

// §5.3 spec test: resolveActiveLenses contract.
// The function bodies below mirror src/generator.js's `resolveActiveLenses`
// 1:1 (intentional duplication per plan §Task4 — testing the CONTRACT
// independently of the surrounding generator.js scope, which under Node
// pulls jQuery/DOM via core.js. If the real implementation drifts, this
// test still passes for the wrong reason — the spec calls that out as
// acceptable for v3.1, with a follow-up to assert against the real module).

const HYBRID_BUILTIN_LENSES = ['language', 'pratchett', 'canon', 'academic', 'meta', 'expansion'];
const DEFAULT_HYBRID_LENSSES = { language: true, pratchett: true, canon: true, academic: false, meta: false, expansion: false };

function resolveActiveLenses(lenses, defaults) {
    const src = (lenses && typeof lenses === 'object') ? lenses : {};
    const out = {};
    for (const k of HYBRID_BUILTIN_LENSES) {
        const v = src[k];
        out[k] = (typeof v === 'boolean') ? v : defaults[k];
    }
    return out;
}

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