// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Characterization tests for the lifecycle-facing modules touched in the
// hardening stage:
//   - src/commands.js: idempotent permanent slash-command + debug registration
//   - src/events.js:  bindEvents/unbindEvents symmetry + removeListener calls
//
// The stub-runtime installs a minimal document + SillyTavern context. We extend
// the per-test context with the host APIs these modules read (eventSource,
// SlashCommandParser/SlashCommand, registerDebugFunction).

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import {
    registerSlashCommands, registerDebugFunctions, _test as _commandsTest,
} from '../src/commands.js';
import { bindEvents, unbindEvents } from '../src/events.js';

// Reset the permanent-registration flags before each test so each case can
// exercise the registration lifecycle from a clean state. (_slashRegistered /
// _debugIds model page-lifetime permanence at runtime; tests need isolation.)
function resetRegistrations() {
    _commandsTest?.resetRegistrations?.();
    unbindEvents(); // reset the events bound flag too
}

// ── Slash-command registration ──

test('registerSlashCommands registers the three flat /glosses_* commands', () => {
    resetRegistrations();
    const added = [];
    resetCtx({
        SlashCommandParser: { addCommandObject: (cmd) => { added.push(cmd.name); } },
        SlashCommand: { fromProps: (props) => ({ ...props }) },
    });
    registerSlashCommands();
    assert.deepEqual(added.sort(), ['glosses_clear', 'glosses_regen', 'glosses_toggle']);
});

test('registerSlashCommands is idempotent: a second call does not re-register', () => {
    resetRegistrations();
    let addCount = 0;
    resetCtx({
        SlashCommandParser: { addCommandObject: () => { addCount++; } },
        SlashCommand: { fromProps: (props) => ({ ...props }) },
    });
    registerSlashCommands();
    registerSlashCommands();
    registerSlashCommands();
    // The first call registers all three; subsequent calls are short-circuited
    // by the module-level _slashRegistered flag.
    assert.equal(addCount, 3);
});

test('registerSlashCommands no-ops gracefully when the host API is missing', () => {
    resetRegistrations();
    resetCtx({}); // no SlashCommandParser / SlashCommand
    // Should not throw — a missing API on older builds degrades to a no-op so
    // a later init pass can retry.
    assert.doesNotThrow(() => registerSlashCommands());
    // The success flag must NOT flip on a missing-API no-op, so a later call
    // with the API present still registers.
    assert.equal(_commandsTest.registrationState().slash, false);
    const added = [];
    globalThis._stCtx.SlashCommandParser = { addCommandObject: (cmd) => { added.push(cmd.name); } };
    globalThis._stCtx.SlashCommand = { fromProps: (props) => ({ ...props }) };
    registerSlashCommands();
    assert.deepEqual(added.sort(), ['glosses_clear', 'glosses_regen', 'glosses_toggle']);
});

// ── Debug-function registration ──

test('registerDebugFunctions registers gls_cache_info, gls_clear_cache and gls_toggle_debug_capture', () => {
    resetRegistrations();
    const registered = new Map();
    resetCtx({
        registerDebugFunction: (id, _label, _desc, fn) => { registered.set(id, fn); },
    });
    registerDebugFunctions();
    assert.ok(registered.has('gls_cache_info'));
    assert.ok(registered.has('gls_clear_cache'));
    assert.ok(registered.has('gls_toggle_debug_capture'));
});

test('registerDebugFunctions is idempotent per id', () => {
    resetRegistrations();
    const calls = [];
    resetCtx({
        registerDebugFunction: (id) => { calls.push(id); },
    });
    registerDebugFunctions();
    registerDebugFunctions();
    assert.deepEqual(calls, ['gls_cache_info', 'gls_clear_cache', 'gls_toggle_debug_capture']);
});

// ── Events bind/unbind symmetry ──

test('bindEvents registers handlers on eventSource for the ST events', () => {
    resetRegistrations();
    const onCalls = [];
    const handlers = new Map(); // event -> [fn, fn...]
    resetCtx({
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
        },
        eventSource: {
            on: (ev, fn) => {
                onCalls.push(ev);
                if (!handlers.has(ev)) handlers.set(ev, []);
                handlers.get(ev).push(fn);
            },
            removeListener: () => {},
        },
    });
    bindEvents();
    // Each documented event is bound exactly once.
    assert.equal(onCalls.length, 6);
    for (const ev of ['APP_INITIALIZED', 'CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED',
        'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
        assert.ok(onCalls.includes(ev), `expected ${ev} to be bound`);
    }
});

test('bindEvents is idempotent: a second call binds nothing new', () => {
    resetRegistrations();
    let onCount = 0;
    resetCtx({
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
        },
        eventSource: { on: () => { onCount++; }, removeListener: () => {} },
    });
    bindEvents();
    const firstCount = onCount;
    bindEvents();
    assert.equal(onCount, firstCount, 'second bindEvents added no new handlers');
});

test('unbindEvents calls removeListener for every previously bound handler', () => {
    resetRegistrations();
    const removed = [];
    resetCtx({
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
        },
        eventSource: {
            on: () => {},
            removeListener: (ev, fn) => { removed.push([ev, fn]); },
        },
    });
    bindEvents();
    unbindEvents();
    // Exactly one remove per bound handler.
    assert.equal(removed.length, 6);
    // After unbind, a fresh bindEvents must re-bind (state was reset).
    let onCount = 0;
    globalThis._stCtx.eventSource.on = () => { onCount++; };
    bindEvents();
    assert.equal(onCount, 6, 'bindEvents re-binds after unbindEvents resets the guard');
});

test('unbindEvents is safe when eventSource is unavailable', () => {
    resetRegistrations();
    resetCtx({ eventSource: null });
    // Must not throw — host may be gone during teardown.
    assert.doesNotThrow(() => unbindEvents());
});

test('bindEvents without eventSource does not set the bound flag (a later init retries)', () => {
    resetRegistrations();
    resetCtx({}); // no eventSource / event_types
    assert.doesNotThrow(() => bindEvents());
    // Provide the API and bind again — it should succeed, proving the guard
    // was NOT flipped by the failed first attempt.
    let onCount = 0;
    globalThis._stCtx.event_types = {
        APP_INITIALIZED: 'APP_INITIALIZED',
        CHAT_CHANGED: 'CHAT_CHANGED',
        CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
        MESSAGE_SWIPED: 'MESSAGE_SWIPED',
        MESSAGE_EDITED: 'MESSAGE_EDITED',
        MESSAGE_DELETED: 'MESSAGE_DELETED',
    };
    globalThis._stCtx.eventSource = { on: () => { onCount++; }, removeListener: () => {} };
    bindEvents();
    assert.equal(onCount, 6);
});
