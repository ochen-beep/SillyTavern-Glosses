// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stage 5 (DS Comments port) — notifyUser dedup.
//
// Persistence failures used to be console-only; the writers now surface one
// error toast per dedupeKey per 5 s window. These tests pin the dedup
// contract that keeps event bursts (per-message saves) from toasting storms.

import './helpers/stub-runtime.mjs';
import { notifyUser } from '../src/core.js';

test('notifyUser: same dedupeKey within the window toasts once', () => {
    const calls = [];
    const orig = globalThis.toastr;
    globalThis.toastr = { error: (...a) => calls.push(a) };
    try {
        const first = notifyUser('error', 'Could not save', 'gls-key');
        const second = notifyUser('error', 'Could not save', 'gls-key');
        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'Could not save');
        assert.equal(calls[0][1], 'Glosses');
    } finally {
        globalThis.toastr = orig;
    }
});

test('notifyUser: different dedupeKeys toast independently', () => {
    const calls = [];
    const orig = globalThis.toastr;
    globalThis.toastr = { error: (...a) => calls.push(a) };
    try {
        notifyUser('error', 'metadata failure', 'gls-metadata-save');
        notifyUser('error', 'chat failure', 'gls-chat-save');
        assert.equal(calls.length, 2);
    } finally {
        globalThis.toastr = orig;
    }
});

test('notifyUser: default dedupeKey is the message itself', () => {
    const calls = [];
    const orig = globalThis.toastr;
    globalThis.toastr = { warning: (...a) => calls.push(a) };
    try {
        notifyUser('warning', 'same message');
        notifyUser('warning', 'same message');
        assert.equal(calls.length, 1);
    } finally {
        globalThis.toastr = orig;
    }
});

test('notifyUser: never throws when toastr is absent', () => {
    const orig = globalThis.toastr;
    delete globalThis.toastr;
    try {
        assert.doesNotThrow(() => notifyUser('error', 'no toastr here', 'k'));
    } finally {
        globalThis.toastr = orig;
    }
});
