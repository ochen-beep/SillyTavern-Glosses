import test from 'node:test';
import assert from 'node:assert/strict';

import './helpers/stub-runtime.mjs';
import { resetCtx, makeMessage } from './helpers/stub-runtime.mjs';
import { loadSettings } from '../src/core.js';
import { buildContextBlocks, buildLoreScanInput } from '../src/generator.js';

const POST = 'Aurelia opened the astrolabe beside the old observatory.';

function setup(ctxOverrides = {}, settings = {}) {
    resetCtx({
        chat: [
            makeMessage({ mes: 'Earlier line.', name: 'Char' }),
            makeMessage({ mes: POST, name: 'Char' }),
        ],
        chatId: 'wi-scan',
        chatMetadata: {},
        extensionSettings: { Glosses: settings },
        ...ctxOverrides,
    });
    loadSettings();
}

test('buildLoreScanInput: newest-first messages, raw mes, quiet trigger, scan-state fields', () => {
    setup({
        characters: [{ name: 'Char', description: 'Desc text', personality: 'Bold', scenario: 'The scenario' }],
        characterId: 0,
        powerUserSettings: { persona_description: 'Persona text' },
        name1: 'User',
        name2: 'Char',
    });

    const { chatMessages, globalScanData } = buildLoreScanInput(globalThis._stCtx);

    // Newest-first: the anchor post (index 1) comes BEFORE the earlier line.
    assert.equal(chatMessages.length, 2);
    assert.match(chatMessages[0], new RegExp(POST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(chatMessages[1], /^User: Earlier line\.$|^Char: Earlier line\.$/);
    assert.match(chatMessages[0], /^Char: /);

    assert.equal(globalScanData.trigger, 'quiet');
    assert.equal(globalScanData.characterDescription, 'Desc text');
    assert.equal(globalScanData.characterPersonality, 'Bold');
    assert.equal(globalScanData.scenario, 'The scenario');
    assert.equal(globalScanData.personaDescription, 'Persona text');
});

test('buildLoreScanInput: system/hidden messages are excluded', () => {
    setup({
        chat: [
            makeMessage({ mes: 'Hidden note.', is_hidden: true }),
            makeMessage({ mes: 'System note.', is_system: true }),
            makeMessage({ mes: POST }),
        ],
    });
    const { chatMessages } = buildLoreScanInput(globalThis._stCtx);
    assert.equal(chatMessages.length, 1);
    assert.match(chatMessages[0], /astrolabe/);
});

test('buildLoreScanInput: tolerates missing character and persona surfaces', () => {
    setup({});
    const { chatMessages, globalScanData } = buildLoreScanInput(globalThis._stCtx);
    assert.ok(Array.isArray(chatMessages));
    assert.deepEqual(globalScanData, { trigger: 'quiet' });
});

test('includeLorebook: dry-run scan with globalScanData; result lands in the WI block', async () => {
    const calls = [];
    setup(
        {
            characters: [{ name: 'Char', description: 'Desc text' }],
            characterId: 0,
            powerUserSettings: { persona_description: 'Persona text' },
            getWorldInfoPrompt: (messages, maxContext, isDryRun, scanData) => {
                calls.push({ messages, maxContext, isDryRun, scanData });
                return { worldInfoString: 'Lore: the astrolabe guild.' };
            },
        },
        { includeLorebook: true },
    );

    const blocks = await buildContextBlocks(1, 0);
    assert.equal(calls.length, 1);

    // THE CONTRACT: isDryRun must always be true — a non-dry-run scan writes
    // sticky/cooldown timed-effects into chat_metadata outside ST's cycle.
    assert.equal(calls[0].isDryRun, true);
    assert.equal(calls[0].scanData.trigger, 'quiet');
    assert.equal(calls[0].scanData.characterDescription, 'Desc text');
    assert.equal(calls[0].scanData.personaDescription, 'Persona text');
    assert.equal(calls[0].maxContext, 16384);

    const wiBlock = blocks.find(b => b.startsWith('[World info'));
    assert.ok(wiBlock, 'WI block present');
    assert.match(wiBlock, /Lore: the astrolabe guild\./);
    assert.match(wiBlock, /background only/);
});

test('includeLorebook: async getWorldInfoPrompt result is awaited', async () => {
    setup(
        {
            getWorldInfoPrompt: async () => ({ worldInfoString: 'Async lore.' }),
        },
        { includeLorebook: true },
    );
    const blocks = await buildContextBlocks(1, 0);
    const wiBlock = blocks.find(b => b.startsWith('[World info'));
    assert.ok(wiBlock);
    assert.match(wiBlock, /Async lore\./);
});

test('includeLorebook: missing getWorldInfoPrompt → no WI block, no throw', async () => {
    setup({}, { includeLorebook: true });
    const blocks = await buildContextBlocks(1, 0);
    assert.ok(!blocks.some(b => b.startsWith('[World info')));
});

test('includeLorebook off: getWorldInfoPrompt is never called', async () => {
    let called = false;
    setup(
        {
            getWorldInfoPrompt: () => { called = true; return { worldInfoString: 'x' }; },
        },
        { includeLorebook: false },
    );
    await buildContextBlocks(1, 0);
    assert.equal(called, false);
});
