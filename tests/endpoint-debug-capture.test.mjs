// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stage 2 (DS Comments port) — debug-capture gating.
//
// With settings.debugMode off (the default) lastCustomEndpointDebug must keep
// only METADATA (url / model / char counts / status) — full prompt bodies hold
// scene text and must not sit in memory for the page lifetime. With debugMode
// on, the previous full-body behaviour is preserved exactly.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { generateWithCustomEndpoint, lastCustomEndpointDebug } from '../src/connection.js';

function setup(settings) {
    resetCtx({ extensionSettings: { Glosses: { source: 'custom', ...settings } } });
    loadSettings();
}

/** Stub the API key store and a successful fetch with a JSON chat-completion body. */
function stubNetwork() {
    const origGetItem = SillyTavern.libs.localforage.getItem;
    const origFetch = globalThis.fetch;
    SillyTavern.libs.localforage.getItem = async (key) =>
        key.includes('apiKey') ? 'SECRET' : null;
    globalThis.fetch = async (_url, opts) => {
        const body = JSON.parse(opts.body);
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'model says hi' } }] }),
            _echoBody: body,
        };
    };
    return () => {
        SillyTavern.libs.localforage.getItem = origGetItem;
        globalThis.fetch = origFetch;
    };
}

test('debugMode off: request/response keep metadata only, no bodies', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' }); // no debugMode → default false
    const restore = stubNetwork();
    try {
        lastCustomEndpointDebug.request = null;
        lastCustomEndpointDebug.response = null;
        const text = await generateWithCustomEndpoint(
            'system prompt with scene text',
            'user prompt with scene text',
            null,
            'https://api.example.com/v1',
            'model-x',
        );
        assert.equal(text, 'model says hi');

        const req = lastCustomEndpointDebug.request;
        assert.ok(req, 'request captured');
        assert.equal(req.url, 'https://api.example.com/v1/chat/completions');
        assert.equal(req.model, 'model-x');
        assert.equal(req.messages, undefined, 'no full messages outside debug mode');
        assert.deepEqual(req.messageChars,
            ['system prompt with scene text'.length, 'user prompt with scene text'.length]);

        const res = lastCustomEndpointDebug.response;
        assert.ok(res, 'response captured');
        assert.equal(res.status, 200);
        assert.equal(res.textChars, 'model says hi'.length);
        assert.equal(res.data, undefined, 'no full response body outside debug mode');
        assert.equal(res.text, undefined, 'no full response text outside debug mode');
    } finally {
        restore();
    }
});

test('debugMode on: full request/response bodies are captured', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1', debugMode: true });
    const restore = stubNetwork();
    try {
        lastCustomEndpointDebug.request = null;
        lastCustomEndpointDebug.response = null;
        await generateWithCustomEndpoint(
            'system prompt with scene text',
            'user prompt with scene text',
            null,
            'https://api.example.com/v1',
            'model-x',
        );

        const req = lastCustomEndpointDebug.request;
        assert.ok(Array.isArray(req.messages), 'full messages kept in debug mode');
        assert.equal(req.messages[0].content, 'system prompt with scene text');

        const res = lastCustomEndpointDebug.response;
        assert.ok(res.data, 'full response data kept in debug mode');
        assert.equal(res.text, 'model says hi');
    } finally {
        restore();
    }
});
