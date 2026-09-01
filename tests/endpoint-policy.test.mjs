// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Plan stage 8 — custom endpoint policy (pure module).
//
// classifyEndpoint is the security boundary BEFORE any API-key read or fetch:
//   - rejects non-http(s) protocols (javascript:, file:, data:, ftp:);
//   - rejects credentials in the URL (user:pass@) — they could leak to the
//     wrong origin on redirect and into logs;
//   - classifies https / loopback-http / insecure-http;
//   - canonicalizes to a chat completions URL.
//
// isOriginAllowed / addToAllowList implement the confirmed-origin allow-list
// that gates non-loopback HTTP requests.

import {
    classifyEndpoint, isOriginAllowed, addToAllowList,
} from '../src/infrastructure/endpoint-policy.js';

// ── Classification ──

test('bare https domain canonicalizes to /v1/chat/completions', () => {
    const v = classifyEndpoint('https://api.example.com');
    assert.equal(v.ok, true);
    assert.equal(v.kind, 'https');
    assert.equal(v.normalized, 'https://api.example.com/v1/chat/completions');
});

test('/v1 path appends chat/completions; completions path passes through', () => {
    assert.equal(classifyEndpoint('https://host/v1').normalized, 'https://host/v1/chat/completions');
    assert.equal(classifyEndpoint('https://host/v1/chat/completions').normalized, 'https://host/v1/chat/completions');
    assert.equal(classifyEndpoint('https://host/openai/v1').normalized, 'https://host/openai/v1/chat/completions');
});

test('trailing slashes are stripped before canonicalization', () => {
    assert.equal(classifyEndpoint('https://host///').normalized, 'https://host/v1/chat/completions');
});

test('loopback http is classified loopback-http and allowed', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '127.0.0.2']) {
        const v = classifyEndpoint(`http://${host}:8080/v1`);
        assert.equal(v.ok, true, `${host} should be a valid loopback URL`);
        assert.equal(v.kind, 'loopback-http', `${host} is loopback`);
        assert.equal(v.normalized, `http://${host}:8080/v1/chat/completions`);
    }
});

test('non-loopback http is classified insecure-http', () => {
    const v = classifyEndpoint('http://api.example.com');
    assert.equal(v.ok, true);
    assert.equal(v.kind, 'insecure-http');
});

test('empty input is rejected', () => {
    assert.equal(classifyEndpoint('').ok, false);
    assert.equal(classifyEndpoint('   ').ok, false);
    assert.equal(classifyEndpoint(null).ok, false);
});

test('non-http(s) protocols are rejected', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x', 'ftp://host', 'ws://host']) {
        const v = classifyEndpoint(bad);
        assert.equal(v.ok, false, `${bad} must be rejected`);
        assert.match(v.error, /protocol/i);
    }
});

test('credentials in the URL are rejected', () => {
    const v = classifyEndpoint('https://user:sekret@api.example.com');
    assert.equal(v.ok, false);
    assert.match(v.error, /credential/i);
});

test('garbage input is rejected as invalid URL', () => {
    const v = classifyEndpoint('not a url at all');
    assert.equal(v.ok, false);
    assert.match(v.error, /invalid url/i);
});

// ── Allow-list ──

test('isOriginAllowed matches on scheme+hostname regardless of path', () => {
    const allow = ['http://api.example.com/v1/chat/completions'];
    assert.equal(isOriginAllowed('http://api.example.com/v1', allow), true);
    assert.equal(isOriginAllowed('http://api.example.com/other', allow), true);
    assert.equal(isOriginAllowed('https://api.example.com/v1', allow), false, 'scheme mismatch');
    assert.equal(isOriginAllowed('http://other.example.com/v1', allow), false, 'host mismatch');
});

test('isOriginAllowed handles malformed entries gracefully', () => {
    assert.equal(isOriginAllowed('https://host/v1', ['not a url']), false);
    assert.equal(isOriginAllowed('', ['https://host']), false);
    assert.equal(isOriginAllowed('https://host/v1', null), false);
});

test('addToAllowList adds a new origin and dedupes existing ones', () => {
    const list = addToAllowList('http://a.example.com/v1', []);
    assert.equal(list.length, 1);
    // Same host, different path → no duplicate.
    const list2 = addToAllowList('http://a.example.com/v1/chat/completions', list);
    assert.equal(list2.length, 1);
    // Different host → appended.
    const list3 = addToAllowList('http://b.example.com/v1', list2);
    assert.equal(list3.length, 2);
    // https vs http same host → distinct entries (different scheme).
    const list4 = addToAllowList('https://a.example.com/v1', list3);
    assert.equal(list4.length, 3);
});
