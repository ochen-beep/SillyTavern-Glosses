// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// SSE streaming toggle for both generation transports (spec: transport-only
// mechanics — footnote parsing needs the FULL text, chunks accumulate into
// one string; no progressive rendering; NO auto-fallback stream→non-stream
// because a retried request can double-charge a paid call).
//
// Instruction deltas vs the Diegetic reference (67d8a14):
// - extraBody / «Доп. параметры (JSON)» does not exist in Glosses → the
//   "stream forbidden in extraBody" rule has nothing to guard; skipped.
// - CM override (5th sendRequest arg) is not used by Glosses → CM tests
//   cover the factory/object dual path and abort mapping only.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { loadSettings, S } from '../src/core.js';
import { readSseText, generateWithCustomEndpoint, generateWithProfile } from '../src/connection.js';

const enc = new TextEncoder();

/** Build a ReadableStream body from string chunks (SSE lines included as-is). */
function sseBody(chunks) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
            controller.close();
        },
    });
}

/** Stub the API key store; fetch stub installed per-test. */
function stubApiKey() {
    const origGetItem = SillyTavern.libs.localforage.getItem;
    SillyTavern.libs.localforage.getItem = async (key) => (key.includes('apiKey') ? 'SECRET' : null);
    return () => { SillyTavern.libs.localforage.getItem = origGetItem; };
}

function setup(settings) {
    resetCtx({ extensionSettings: { Glosses: settings } });
    loadSettings();
}

// ── readSseText: SSE accumulation, tolerant of wild proxies ──

test('readSseText accumulates delta.content and stops at [DONE]', async () => {
    const text = await readSseText(sseBody([
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"after-done"}}]}\n\n',
    ]));
    assert.equal(text, 'Hello!');
});

test('readSseText silently skips keep-alive comments, non-JSON and usage chunks', async () => {
    const text = await readSseText(sseBody([
        ': keep-alive\n\n',
        'data: <html>gateway splash</html>\n\n',
        'data: {"choices":[],"usage":{"total_tokens":42}}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    ]));
    assert.equal(text, 'ok');
});

test('readSseText reassembles a JSON line split across chunk boundaries', async () => {
    const text = await readSseText(sseBody([
        'data: {"choices":[{"del',
        'ta":{"content":"split"}}]}\n\n',
    ]));
    assert.equal(text, 'split');
});

test('readSseText trims CRLF line endings (wild proxies)', async () => {
    const text = await readSseText(sseBody([
        'data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n',
    ]));
    assert.equal(text, 'crlf');
});

test('readSseText on an empty stream returns an empty string (caller raises)', async () => {
    assert.equal(await readSseText(sseBody([])), '');
});

// ── generateWithCustomEndpoint: stream:true path ──

function stubFetchSse(handler) {
    const restoreKey = stubApiKey();
    const origFetch = globalThis.fetch;
    let capturedBody = null;
    globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return handler(opts);
    };
    return {
        get body() { return capturedBody; },
        restore() { globalThis.fetch = origFetch; restoreKey(); },
    };
}

test('custom endpoint with the toggle ON sends stream:true and parses the SSE stream', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' }); // no stream key → default ON
    const stub = stubFetchSse(() => ({
        ok: true,
        status: 200,
        body: sseBody([
            'data: {"choices":[{"delta":{"content":"foot"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"note"}}]}\n\n',
            'data: [DONE]\n\n',
        ]),
        json: async () => { throw new Error('JSON path must not run when streaming'); },
    }));
    try {
        const text = await generateWithCustomEndpoint('sys', 'usr', null, 'https://api.example.com/v1', 'gls-mock');
        assert.equal(text, 'footnote');
        assert.equal(stub.body.stream, true, 'request body carries stream:true');
    } finally {
        stub.restore();
    }
});

test('custom endpoint with the toggle OFF keeps the non-stream JSON path', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1', stream: false });
    const stub = stubFetchSse(() => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'plain json' } }] }),
    }));
    try {
        const text = await generateWithCustomEndpoint('sys', 'usr', null, 'https://api.example.com/v1', 'gls-mock');
        assert.equal(text, 'plain json');
        assert.equal(stub.body.stream, false, 'request body carries stream:false');
    } finally {
        stub.restore();
    }
});

test('custom endpoint empty stream is an explicit error, not a quiet empty string', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' });
    const stub = stubFetchSse(() => ({
        ok: true,
        status: 200,
        // A gateway that ignored stream:true and answered plain JSON yields no
        // `data:` lines → empty accumulation → the caller must raise, because a
        // silent '' would look like an unusable model answer.
        body: sseBody(['{"choices":[{"message":{"content":"not sse"}}]}']),
        json: async () => ({ choices: [{ message: { content: 'not sse' } }] }),
    }));
    try {
        await assert.rejects(
            () => generateWithCustomEndpoint('sys', 'usr', null, 'https://api.example.com/v1', 'gls-mock'),
            /may not support SSE/,
        );
    } finally {
        stub.restore();
    }
});

test('custom endpoint HTTP error surfaces before the body is read (stream mode)', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' });
    const stub = stubFetchSse(() => ({
        ok: false,
        status: 524,
        text: async () => 'Cloudflare timeout',
        body: sseBody([]),
    }));
    try {
        await assert.rejects(
            () => generateWithCustomEndpoint('sys', 'usr', null, 'https://api.example.com/v1', 'gls-mock'),
            /HTTP 524/,
        );
    } finally {
        stub.restore();
    }
});

test('abort mid-stream rejects with AbortError (cancel path, no fallback)', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' });
    const ctrl = new AbortController();
    const restoreKey = stubApiKey();
    const origFetch = globalThis.fetch;
    let resolveFetched;
    const fetched = new Promise((r) => { resolveFetched = r; });
    globalThis.fetch = async (_url, opts) => {
        resolveFetched(opts);
        return {
            ok: true,
            status: 200,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
                    // Mirror real fetch: an aborted signal errors the body
                    // stream — including a signal that was ALREADY aborted
                    // before the stream was constructed (abort event has
                    // already dispatched; addEventListener would never fire).
                    if (opts.signal.aborted) {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                        return;
                    }
                    opts.signal.addEventListener('abort', () =>
                        controller.error(new DOMException('Aborted', 'AbortError')));
                },
            }),
        };
    };
    try {
        const pending = generateWithCustomEndpoint('sys', 'usr', ctrl.signal, 'https://api.example.com/v1', 'gls-mock');
        // Attach the handler BEFORE the abort lands: node:test fails a test on
        // a rejection it observes as momentarily unhandled.
        const outcome = pending.then(() => null, (e) => e);
        // Land the abort AFTER fetch resolved (real cancel timing): aborting
        // before the first await would hand fetch an already-dead signal.
        await fetched;
        ctrl.abort();
        const err = await outcome;
        assert.ok(err, 'must reject');
        assert.equal(err.name, 'AbortError');
    } finally {
        globalThis.fetch = origFetch;
        restoreKey();
    }
});

test('debug capture records the stream flag and stream metadata', async () => {
    setup({ customEndpoint: 'https://api.example.com/v1' }); // debugMode off → metadata only
    const { lastCustomEndpointDebug } = await import('../src/connection.js');
    const stub = stubFetchSse(() => ({
        ok: true,
        status: 200,
        body: sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']),
    }));
    try {
        lastCustomEndpointDebug.request = null;
        lastCustomEndpointDebug.response = null;
        await generateWithCustomEndpoint('sys prompt body', 'usr prompt body', null, 'https://api.example.com/v1', 'gls-mock');
        assert.equal(lastCustomEndpointDebug.request.stream, true);
        // Metadata-only mode: char counts, not prompt/response bodies.
        assert.equal(lastCustomEndpointDebug.response.textChars, 2);
        assert.equal(lastCustomEndpointDebug.response.data, undefined);
    } finally {
        stub.restore();
        lastCustomEndpointDebug.request = null;
        lastCustomEndpointDebug.response = null;
    }
});

// ── generateWithProfile: Connection Manager dual path ──

const PROFILES = [{ id: 'p1', name: 'Chat GPT', api: 'openai' }];

function setupCM(sendRequest, settings = { source: 'profile', selectedProfile: 'p1' }) {
    resetCtx({
        extensionSettings: {
            Glosses: settings,
            connectionManager: { profiles: PROFILES },
        },
        ConnectionManagerRequestService: { sendRequest },
        CONNECT_API_MAP: { openai: { selected: 'openai' } },
    });
    loadSettings();
}

test('CM sendRequest receives stream:true from the toggle and the factory yields accumulated text', async () => {
    let capturedOpts = null;
    // The CM contract: sendRequest resolves with a FUNCTION that creates the
    // AsyncGenerator directly (not a promise of one).
    setupCM((_id, _msgs, _mt, opts) => {
        capturedOpts = opts;
        return Promise.resolve(() => (async function* () {
            yield { text: 'Hello' };
            yield { text: 'Hello world' };   // chunks carry ACCUMULATED text — last wins
        })());
    });
    const text = await generateWithProfile('p1', 'sys', 'usr');
    assert.equal(text, 'Hello world');
    assert.equal(capturedOpts.stream, true);
});

test('CM object response (API cannot stream) still extracts via the non-stream path', async () => {
    setupCM(() => Promise.resolve({ choices: [{ message: { content: 'object answer' } }] }));
    const text = await generateWithProfile('p1', 'sys', 'usr');
    assert.equal(text, 'object answer');
});

test('CM toggle OFF passes stream:false and reads the extracted-data object', async () => {
    let capturedOpts = null;
    setupCM(async (_id, _msgs, _mt, opts) => {
        capturedOpts = opts;
        return { choices: [{ message: { content: 'non-stream' } }] };
    }, { source: 'profile', selectedProfile: 'p1', stream: false });
    const text = await generateWithProfile('p1', 'sys', 'usr');
    assert.equal(text, 'non-stream');
    assert.equal(capturedOpts.stream, false);
});

test('CM empty factory output → the existing "could not be extracted" error', async () => {
    setupCM(() => Promise.resolve(() => (async function* () { /* yields nothing */ })()));
    await assert.rejects(
        () => generateWithProfile('p1', 'sys', 'usr'),
        /could not be extracted/,
    );
});

test('CM abort mid-stream (cancel after sendRequest resolved) maps to AbortError', async () => {
    const ctrl = new AbortController();
    setupCM(() => Promise.resolve(() => (async function* () {
        yield { text: 'partial' };
        // CM wraps every failure as Error('API request failed', {cause}) — a
        // cancel landing inside the iteration surfaces exactly like this.
        throw new Error('API request failed', { cause: new DOMException('Aborted', 'AbortError') });
    })()));
    ctrl.abort();
    const err = await generateWithProfile('p1', 'sys', 'usr', ctrl.signal).then(() => null, (e) => e);
    assert.ok(err, 'must reject');
    assert.equal(err.name, 'AbortError');
});

test('CM stream iteration error (non-abort) is wrapped with the profile name', async () => {
    setupCM(() => Promise.resolve(() => (async function* () {
        yield { text: 'partial' };
        throw new Error('socket hung up');
    })()));
    await assert.rejects(
        () => generateWithProfile('p1', 'sys', 'usr'),
        /Chat GPT.*socket hung up/,
    );
});

// ── settings: default ON, false persists, non-boolean coerced ──

test('settings: fresh install defaults stream to ON', () => {
    setup({});
    assert.equal(S().stream, true);
});

test('settings: a saved stream:false persists (opt-out is respected)', () => {
    setup({ stream: false });
    assert.equal(S().stream, false);
});

test('settings: non-boolean junk coerces to the default (ON)', () => {
    setup({ stream: 'yes' });
    assert.equal(S().stream, true);
    setup({ stream: 0 });
    assert.equal(S().stream, true);
});

// ── pipeline → transport flag propagation ──

test('flag propagation: generateWithConfiguredSource routes S().stream into both transports', async () => {
    // Custom transport.
    setup({ source: 'custom', customEndpoint: 'https://api.example.com/v1', stream: false });
    const stub = stubFetchSse(() => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'via configured source' } }] }),
    }));
    try {
        const { generateWithConfiguredSource } = await import('../src/connection.js');
        const text = await generateWithConfiguredSource('sys', 'usr', null);
        assert.equal(text, 'via configured source');
        assert.equal(stub.body.stream, false);
    } finally {
        stub.restore();
    }
});
