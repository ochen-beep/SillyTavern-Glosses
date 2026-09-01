// @ts-check
// Browser-load regression for the extension's module graph.
//
// commands.js's test-only export used `process?.env?.NODE_TEST` with a BARE
// `process` identifier. In the browser `process` is not declared at all, and
// optional chaining does not guard against undeclared identifiers — the line
// threw ReferenceError at module top level, the whole index.js module graph
// failed to evaluate, and ST reported the extension as dead at the activate
// hook ("callExtensionHook: Error calling hook 'activate' ... ReferenceError:
// process is not defined at commands.js:178"). generator.js already read
// `process` via globalThis (its NOTE at src/generator.js:940-945); commands.js
// had missed the same rule.
//
// This test simulates a browser-like environment (no `process` global) and
// verifies the ENTIRE module graph reachable from commands.js evaluates
// without throwing — i.e. the extension can actually load in the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';

test('module graph evaluates with no `process` global (browser-like)', async () => {
    const origProcess = globalThis.process;
    // Simulate a browser where `process` does not exist at all. Setting the
    // property to undefined is NOT enough — an existing property with value
    // undefined still satisfies the identifier lookup, and `process?.env`
    // short-circuits to undefined instead of throwing. Only deleting the
    // property reproduces the browser's ReferenceError for bare `process`.
    // (Node's globalThis.process is a configurable accessor, so delete works.)
    delete globalThis.process;
    try {
        // Fresh process: no other test file has imported commands.js, so this
        // is the first evaluation of the whole graph (core → cache → renderer
        // → generator → ui/* → commands). The regression threw here.
        const mod = await import('../src/commands.js');
        assert.equal(mod._test, null, 'test-only surface is gated OFF in a browser-like env');
    } finally {
        Object.defineProperty(globalThis, 'process', { value: origProcess, configurable: true });
    }
});
