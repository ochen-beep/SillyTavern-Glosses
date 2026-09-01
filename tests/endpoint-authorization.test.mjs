// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plan stage 8 — endpoint authorization ordering.
//
// checkSourceConfigured must authorize the custom endpoint URL BEFORE reading
// the API key: a malformed / insecure / credentialed URL must never reach the
// key read (and therefore never trigger a credentialed fetch). These tests
// spy on localforage.getItem (the getApiKey backing store) to prove ordering.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { checkSourceConfigured, confirmInsecureEndpoint } from '../src/connection.js';

function setup(settings) {
    resetCtx({ extensionSettings: { Glosses: settings } });
    loadSettings();
}

test('insecure-http endpoint is rejected before the API key is read', async () => {
    setup({ source: 'custom', customEndpoint: 'http://api.example.com/v1' });
    // Spy: getApiKey → localforage.getItem. If the endpoint check runs first,
    // this is never called.
    const origGetItem = SillyTavern.libs.localforage.getItem;
    let keyReads = 0;
    SillyTavern.libs.localforage.getItem = async () => { keyReads++; return 'SECRET'; };
    try {
        const r = await checkSourceConfigured();
        assert.equal(r.ok, false);
        assert.match(r.reason, /confirm this origin/i);
        assert.equal(keyReads, 0, 'API key must not be read before endpoint authorization');
    } finally {
        SillyTavern.libs.localforage.getItem = origGetItem;
    }
});

test('malformed endpoint URL is rejected before the API key is read', async () => {
    setup({ source: 'custom', customEndpoint: 'javascript:alert(1)' });
    const origGetItem = SillyTavern.libs.localforage.getItem;
    let keyReads = 0;
    SillyTavern.libs.localforage.getItem = async () => { keyReads++; return 'SECRET'; };
    try {
        const r = await checkSourceConfigured();
        assert.equal(r.ok, false);
        assert.match(r.reason, /protocol/i);
        assert.equal(keyReads, 0);
    } finally {
        SillyTavern.libs.localforage.getItem = origGetItem;
    }
});

test('https endpoint with a valid key is authorized', async () => {
    setup({ source: 'custom', customEndpoint: 'https://api.example.com/v1' });
    const origGetItem = SillyTavern.libs.localforage.getItem;
    SillyTavern.libs.localforage.getItem = async () => 'SECRET';
    try {
        const r = await checkSourceConfigured();
        assert.equal(r.ok, true);
    } finally {
        SillyTavern.libs.localforage.getItem = origGetItem;
    }
});

test('loopback http endpoint is authorized without confirmation', async () => {
    setup({ source: 'custom', customEndpoint: 'http://localhost:8080/v1' });
    const origGetItem = SillyTavern.libs.localforage.getItem;
    SillyTavern.libs.localforage.getItem = async () => 'SECRET';
    try {
        const r = await checkSourceConfigured();
        assert.equal(r.ok, true, 'loopback http needs no origin confirmation');
    } finally {
        SillyTavern.libs.localforage.getItem = origGetItem;
    }
});

test('confirmInsecureEndpoint adds the origin to the allow-list, after which the endpoint is authorized', async () => {
    setup({ source: 'custom', customEndpoint: 'http://api.example.com/v1' });
    const r0 = await checkSourceConfigured();
    assert.equal(r0.ok, false, 'blocked before confirmation');

    const confirmed = await confirmInsecureEndpoint('http://api.example.com/v1/chat/completions', []);
    assert.equal(confirmed.ok, true);

    // After persistence, the endpoint is authorized.
    const origGetItem = SillyTavern.libs.localforage.getItem;
    SillyTavern.libs.localforage.getItem = async () => 'SECRET';
    try {
        const r1 = await checkSourceConfigured();
        assert.equal(r1.ok, true, 'confirmed origin is authorized');
    } finally {
        SillyTavern.libs.localforage.getItem = origGetItem;
    }
});
