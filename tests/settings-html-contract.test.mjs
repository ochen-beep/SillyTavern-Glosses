// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import './helpers/stub-runtime.mjs';
import { MAX_FOOTNOTES_CAP, CONTEXT_DEPTH_MAX } from '../src/core.js';

// The numeric settings live in two places that must agree: core's constants
// (the loadSettings repair + the generator's ceiling) and the min/max
// attributes the inputs declare in settings.html (spinner bounds + bindNum's
// typed-value clamp). A drift between them reads to the user as "the setting
// won't stick" or silently snaps back after reload — this test fails before
// such a change can ship.
const html = readFileSync(fileURLToPath(new URL('../settings.html', import.meta.url)), 'utf8');

function inputAttrs(id) {
    const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `settings.html must contain the #${id} input`);
    const attrs = {};
    for (const [, k, v] of m[0].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
    return attrs;
}

test('gls_max_footnotes input matches MAX_FOOTNOTES_CAP', () => {
    const attrs = inputAttrs('gls_max_footnotes');
    assert.equal(attrs.min, '1');
    assert.equal(attrs.max, String(MAX_FOOTNOTES_CAP));
});

test('gls_context_depth input matches CONTEXT_DEPTH_MAX', () => {
    const attrs = inputAttrs('gls_context_depth');
    assert.equal(attrs.min, '0');
    assert.equal(attrs.max, String(CONTEXT_DEPTH_MAX));
});
