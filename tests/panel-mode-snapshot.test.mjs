// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Owner decision 2026-11-15 — the pre-panel-mode {enabled, hidden} pair must
// survive a reload / server restart that happens INSIDE panel mode, and the
// explicit panel controls inside the mode must update it (the user's latest
// explicit choice wins on exit). updatePanelModeSnapshot persists the pair
// while panel mode is active and is a no-op outside it; loadSettings
// shape-guards the persisted field against stale/hand-edited values.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S, updatePanelModeSnapshot } from '../src/core.js';

function setup() {
    resetCtx();
    loadSettings();
}

test('outside panel mode the snapshot call is a no-op', () => {
    setup();
    S().displayMode = 'both';
    S().floatingPanelEnabled = true;
    S().floatingPanelHidden = false;
    updatePanelModeSnapshot();
    assert.equal(S().panelModeSnapshot, null);
});

test('inside panel mode the snapshot mirrors the live pair, latest choice wins', () => {
    setup();
    S().displayMode = 'panel';
    S().floatingPanelEnabled = true;
    S().floatingPanelHidden = false;
    updatePanelModeSnapshot();
    assert.deepEqual(S().panelModeSnapshot, { enabled: true, hidden: false });
    // The user's later explicit choice (checkbox / ✕ / launcher) overwrites it.
    S().floatingPanelHidden = true;
    updatePanelModeSnapshot();
    assert.deepEqual(S().panelModeSnapshot, { enabled: true, hidden: true });
});

test('loadSettings shape-guards a hand-edited snapshot', () => {
    resetCtx({ extensionSettings: { Glosses: { panelModeSnapshot: { enabled: 'yes', hidden: 0 } } } });
    loadSettings();
    assert.equal(S().panelModeSnapshot, null);
});
