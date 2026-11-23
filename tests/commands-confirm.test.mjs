// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

// Q#2 (QA 2026-11-03) — /glosses_clear was the only chat-wide clear path
// without a confirmation (the pool manager and the panel's per-message clear
// both confirm). The slash callback must now route through showConfirmModal:
// declined → nothing is wiped; accepted → cache cleared.

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings, state } from '../src/core.js';
import { saveFootnotes, stats } from '../src/cache.js';
import { registerSlashCommands } from '../src/commands.js';
import { _test as commandsTestHooks } from '../src/commands.js';

function setup({ confirmAnswer }) {
    const registered = [];
    resetCtx({
        chat: [makeMessage({ mes: 'A post that carries footnotes.' })],
        chatId: 'commands-confirm',
        chatMetadata: {},
        extensionSettings: { Glosses: { enabled: true } },
        SlashCommandParser: { addCommandObject: (cmd) => registered.push(cmd) },
        SlashCommand: { fromProps: (p) => p },
    });
    globalThis.window.confirm = () => confirmAnswer;
    loadSettings();
    state.runtimeActive = true;
    commandsTestHooks.resetRegistrations();
    registerSlashCommands();
    const clearCmd = registered.find(c => c.name === 'glosses_clear');
    assert.ok(clearCmd, 'glosses_clear registered');
    return { clearCmd };
}

test('/glosses_clear with a declined confirm wipes nothing', async () => {
    const { clearCmd } = setup({ confirmAnswer: false });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'footnotes', text: '¹ footnotes — the thing.' }], {});
    assert.ok(stats().entries, 'payload present before the command');
    const result = await clearCmd.callback();
    assert.equal(stats().entries, 1, 'payload survives the declined confirm');
    assert.match(String(result), /Cancelled/i);
});

test('/glosses_clear with an accepted confirm clears the chat', async () => {
    const { clearCmd } = setup({ confirmAnswer: true });
    saveFootnotes('0', 0, [{ index: 1, anchor: 'footnotes', text: '¹ footnotes — the thing.' }], {});
    const result = await clearCmd.callback();
    assert.equal(stats().entries, 0, 'payload wiped');
    assert.match(String(result), /cleared/i);
});

test('/glosses_clear stays inert while the runtime is down', async () => {
    const { clearCmd } = setup({ confirmAnswer: true });
    state.runtimeActive = false;
    saveFootnotes('0', 0, [{ index: 1, anchor: 'footnotes', text: '¹ footnotes — the thing.' }], {});
    const result = await clearCmd.callback();
    assert.equal(stats().entries, 1, 'no wipe while disabled');
    assert.match(String(result), /disabled/i);
});
