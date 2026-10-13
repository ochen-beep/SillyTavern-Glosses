import { test } from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { getForcedIgnore, saveForcedIgnore, getPoolExcluded, togglePoolExcluded, flushWriters } from '../src/cache.js';
import { resetCtx } from './helpers/stub-runtime.mjs';

test('getForcedIgnore returns [] for legacy stores', () => {
    resetCtx({ chatMetadata: { gls_data: { forcedIgnore: ['  КОТ  ', 'кот'] } } });
    // Normalized on read by the repository
    assert.deepEqual(getForcedIgnore(), ['КОТ']);
});

test('saveForcedIgnore trims, normalizes duplicates, preserves first display form', async () => {
    resetCtx();
    const result = saveForcedIgnore(['  КОТ  ', 'кот', '', 'мир — здесь', 'мир - здесь']);
    assert.deepEqual(result, ['КОТ', 'мир — здесь']);
    assert.deepEqual(getForcedIgnore(), ['КОТ', 'мир — здесь']);
    await flushWriters();
});

test('getPoolExcluded returns [] for legacy stores without the field', () => {
    resetCtx({ chatMetadata: { gls_data: { forcedIgnore: [] } } });
    assert.deepEqual(getPoolExcluded(), []);
});

test('getPoolExcluded normalizes persisted values', () => {
    resetCtx({ chatMetadata: { gls_data: { forcedIgnore: [], poolExcluded: ['  Маршалл  ', 'маршалл', '', 'Kohl — here', 'kohl - here'] } } });
    assert.deepEqual(getPoolExcluded(), ['Маршалл', 'Kohl — here']);
});

test('togglePoolExcluded adds and removes a single anchor by normalized key', () => {
    resetCtx();
    togglePoolExcluded('Marshall', true);
    assert.deepEqual(getPoolExcluded(), ['Marshall']);
    togglePoolExcluded('MARSHALL', true);
    assert.deepEqual(getPoolExcluded(), ['Marshall']);
    togglePoolExcluded('Marshall', false);
    assert.deepEqual(getPoolExcluded(), []);
    togglePoolExcluded('Marshall', false);
    assert.deepEqual(getPoolExcluded(), []);
});