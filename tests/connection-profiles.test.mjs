// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Glosses sends a chat-completions `messages` array through Connection
// Manager. A text-completion profile would receive that array as its raw
// `prompt` and produce garbage on the backend, so only Chat Completion
// profiles may be offered — and a selection saved before the dropdown was
// filtered must fail with a clear error instead of a malformed request.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { getProfiles, generateWithProfile } from '../src/connection.js';

const PROFILES = [
    { id: 'p1', name: 'Chat GPT', api: 'openai' },
    { id: 'p2', name: 'KoboldTC', api: 'textgenerationwebui' },
    { id: 'p3', name: 'No api' },
];

function freshCtx({ apiMap = true } = {}) {
    resetCtx({
        extensionSettings: { connectionManager: { profiles: PROFILES } },
        ConnectionManagerRequestService: { sendRequest: async () => ({}) },
        CONNECT_API_MAP: apiMap
            ? {
                openai: { selected: 'openai' },
                textgenerationwebui: { selected: 'textgenerationwebui', type: 'koboldcpp' },
            }
            : undefined,
    });
}

test('getProfiles offers only Chat Completion profiles', async () => {
    freshCtx();
    const list = await getProfiles();
    assert.deepEqual(list, [{ id: 'p1', name: 'Chat GPT' }]);
});

test('getProfiles falls back to api === openai when the host lacks CONNECT_API_MAP', async () => {
    freshCtx({ apiMap: false });
    const list = await getProfiles();
    assert.deepEqual(list, [{ id: 'p1', name: 'Chat GPT' }]);
});

test('generateWithProfile rejects a stale text-completion selection with a clear error', async () => {
    freshCtx();
    await assert.rejects(
        () => generateWithProfile('p2', 'system prompt', 'user prompt'),
        /Text Completion/,
    );
});
