// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plan stage 7 — settings panel listener ownership.
//
// bindSettingsUI threads a module-owned AbortController's signal into every
// addEventListener via the on() helper; unbindSettingsUI aborts it, which the
// DOM spec defines as removing every listener bound with that signal. These
// tests pin the lifecycle mechanics under the stub-runtime (no real DOM): the
// controller is created on bind, aborted on unbind, never duplicated by an
// idempotent second bind, and a disable/enable cycle gets a fresh controller.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import {
    bindSettingsUI, unbindSettingsUI,
} from '../src/ui/settings-sync.js';
import { loadSettings, S } from '../src/core.js';

// bindSettingsUI refuses to bind without the settings container in the DOM;
// these tests exercise the controller lifecycle, not the container lookup.
const _origById = globalThis.document.getElementById;
globalThis.document.getElementById = (id) => id === 'gls_settings_container' ? {} : _origById(id);

function freshSettingsContext() {
    resetCtx({ extensionSettings: { Glosses: {} } });
    loadSettings();
}

test('bindSettingsUI creates an AbortController that unbindSettingsUI aborts', () => {
    freshSettingsContext();
    // Spy on AbortController: count creations and aborts.
    const origCtor = globalThis.AbortController;
    let created = 0;
    const controllers = [];
    class SpyAbortController {
        constructor() { created++; this.signal = {}; this.aborted = false; controllers.push(this); }
        abort() { this.aborted = true; }
    }
    globalThis.AbortController = SpyAbortController;
    try {
        bindSettingsUI();
        assert.equal(created, 1, 'one controller created on bind');
        assert.equal(controllers[0].aborted, false, 'not aborted while bound');
        unbindSettingsUI();
        assert.equal(controllers[0].aborted, true, 'unbind aborts the controller (removes listeners)');
    } finally {
        globalThis.AbortController = origCtor;
    }
});

test('bindSettingsUI is idempotent — a second bind does not create a second controller', () => {
    freshSettingsContext();
    const origCtor = globalThis.AbortController;
    let created = 0;
    globalThis.AbortController = class { constructor() { created++; this.signal = {}; } abort() {} };
    try {
        bindSettingsUI();
        bindSettingsUI();
        assert.equal(created, 1, 'idempotent bind: no duplicate controller');
        unbindSettingsUI();
    } finally {
        globalThis.AbortController = origCtor;
    }
});

test('unbindSettingsUI is idempotent — a second unbind does not abort again or throw', () => {
    freshSettingsContext();
    const origCtor = globalThis.AbortController;
    let aborted = 0;
    globalThis.AbortController = class {
        constructor() { this.signal = {}; }
        abort() { aborted++; }
    };
    try {
        bindSettingsUI();
        unbindSettingsUI();
        unbindSettingsUI();
        assert.equal(aborted, 1, 'second unbind is a no-op (controller already gone)');
    } finally {
        globalThis.AbortController = origCtor;
    }
});

test('a disable/enable cycle gets a fresh controller (no listener leak across cycles)', () => {
    freshSettingsContext();
    const origCtor = globalThis.AbortController;
    const created = [];
    globalThis.AbortController = class {
        constructor() { this.signal = {}; this.aborted = false; created.push(this); }
        abort() { this.aborted = true; }
    };
    try {
        bindSettingsUI();
        unbindSettingsUI();
        bindSettingsUI(); // re-enable
        assert.equal(created.length, 2, 'fresh controller per bind cycle');
        assert.equal(created[0].aborted, true, 'first cycle controller aborted');
        assert.equal(created[1].aborted, false, 'new cycle controller active');
        unbindSettingsUI();
        assert.equal(created[1].aborted, true);
    } finally {
        globalThis.AbortController = origCtor;
    }
});

test('launcher mode select initializes from settings and writes changes back', () => {
    freshSettingsContext();
    S().launcherMode = 'floating';
    // Minimal fake select: bindSettingsUI only needs value + addEventListener
    // (every other element lookup returns null and its binding is skipped).
    const listeners = {};
    const select = {
        value: '',
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    };
    let saves = 0;
    globalThis._stCtx.saveSettingsDebounced = () => { saves++; };
    const origById = document.getElementById;
    document.getElementById = (id) => {
        if (id === 'gls_settings_container') return {};
        return id === 'gls_launcher_mode' ? select : null;
    };
    try {
        bindSettingsUI();
        assert.equal(select.value, 'floating', 'select initialized from settings on bind');
        // Switching back to 'bar' keeps the change handler on the remove-only
        // path of ensureLauncher() (safe under the no-DOM stub; the FAB mount
        // path needs a real body/appendChild).
        select.value = 'bar';
        for (const fn of listeners.change ?? []) fn();
        assert.equal(S().launcherMode, 'bar', 'change writes settings.launcherMode');
        assert.ok(saves > 0, 'change persists settings');
    } finally {
        document.getElementById = origById;
        unbindSettingsUI();
    }
});
