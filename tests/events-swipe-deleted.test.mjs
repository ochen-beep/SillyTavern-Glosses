// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stage 4 (DS Comments port) — MESSAGE_SWIPE_DELETED handling.
//
// The event (feature-detected) must abort any in-flight generation for the
// message (its target may have been the deleted variant), strip stale markers,
// and re-present the now-current variant. Payloads themselves live inside
// swipe_info and die with the splice — the handler is about state/UI.

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import { generationCoordinator } from '../src/application/generation-coordinator.js';
import { bindEvents, unbindEvents } from '../src/events.js';

function setup({ eventTypes = {}, chat = [] } = {}) {
    const handlers = new Map();
    resetCtx({
        chat,
        chatId: 'swipe-deleted',
        chatMetadata: {},
        extensionSettings: { Glosses: { enabled: true } },
        event_types: {
            APP_INITIALIZED: 'APP_INITIALIZED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            MESSAGE_SWIPED: 'MESSAGE_SWIPED',
            MESSAGE_EDITED: 'MESSAGE_EDITED',
            MESSAGE_UPDATED: 'MESSAGE_UPDATED',
            MESSAGE_DELETED: 'MESSAGE_DELETED',
            MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED',
            ...eventTypes,
        },
        eventSource: {
            on: (ev, fn) => {
                if (!handlers.has(ev)) handlers.set(ev, []);
                handlers.get(ev).push(fn);
            },
            removeListener: (ev, fn) => {
                const list = handlers.get(ev) || [];
                const i = list.indexOf(fn);
                if (i >= 0) list.splice(i, 1);
            },
        },
    });
    loadSettings();
    bindEvents();
    return {
        fire: (ev, arg) => Promise.all((handlers.get(ev) || []).map(fn => fn(arg))),
        handlers,
    };
}

test('MESSAGE_SWIPE_DELETED aborts the message in-flight run and stays current-safe', async () => {
    const { fire } = setup({
        chat: [makeMessage({ mes: 'Survivor variant text here.' })],
    });
    try {
        const run = generationCoordinator.beginRun('0');
        assert.equal(generationCoordinator.isCurrent(run), true);

        await fire('MESSAGE_SWIPE_DELETED', { messageId: 0 });

        assert.equal(run.ctrl.signal.aborted, true, 'in-flight run aborted');
        assert.equal(generationCoordinator.isCurrent(run), false, 'run is no longer current');
        // The run's own finally (endRun) still owns slot release — the
        // coordinator contract keeps the slot until the aborted run settles.
        assert.equal(generationCoordinator.endRun(run), true, 'aborted owner can release its slot');
        assert.equal(state.abortControllers['0'], undefined, 'slot released');
    } finally {
        unbindEvents();
    }
});

test('MESSAGE_SWIPE_DELETED with no in-flight run does not throw (idempotent)', async () => {
    const { fire } = setup({
        chat: [makeMessage({ mes: 'Survivor variant text here.' })],
    });
    try {
        await assert.doesNotReject(() => fire('MESSAGE_SWIPE_DELETED', { messageId: 0 }));
        await assert.doesNotReject(() => fire('MESSAGE_SWIPE_DELETED', { messageId: 0 }));
    } finally {
        unbindEvents();
    }
});

test('double-fire with SWIPED is harmless (idempotent flows)', async () => {
    const { fire } = setup({
        chat: [makeMessage({ mes: 'Survivor variant text here.' })],
    });
    try {
        const run = generationCoordinator.beginRun('0');
        await fire('MESSAGE_SWIPE_DELETED', { messageId: 0 });
        await fire('MESSAGE_SWIPED', 0);
        assert.equal(generationCoordinator.isCurrent(run), false);
        assert.doesNotThrow(() => generationCoordinator.bumpMessageRevision('0'));
    } finally {
        unbindEvents();
    }
});

test('handler is NOT registered when the host lacks MESSAGE_SWIPE_DELETED', async () => {
    const { handlers } = setup({ eventTypes: { MESSAGE_SWIPE_DELETED: undefined } });
    try {
        assert.equal(handlers.has('MESSAGE_SWIPE_DELETED'), false);
    } finally {
        unbindEvents();
    }
});

test('malformed payload (no messageId) is ignored safely', async () => {
    const { fire } = setup({
        chat: [makeMessage({ mes: 'Survivor variant text here.' })],
    });
    try {
        await assert.doesNotReject(() => fire('MESSAGE_SWIPE_DELETED', {}));
        await assert.doesNotReject(() => fire('MESSAGE_SWIPE_DELETED', undefined));
        // A revision entry keyed "undefined" must NOT have been created.
        assert.equal(state.abortControllers['undefined'], undefined);
    } finally {
        unbindEvents();
    }
});
