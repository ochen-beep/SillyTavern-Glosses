// @ts-check
/**
 * Glosses — Commands module
 * Slash commands (/glosses toggle|regenerate|clear), debug functions, and the
 * Extensions-menu quick entry.
 *
 * Ported 1:1 from SillyTavern-Footnotes. All ST-API registrations are wrapped
 * in try/catch so a missing API on older builds degrades gracefully.
 */

import { state, S, getCtx, saveSettings, log, warn } from './core.js';
import { clearAll, stats } from './cache.js';
import { removeHighlights, restoreHighlightsAll } from './renderer.js';
import { generateFootnotes } from './generator.js';
import { lastCustomEndpointDebug } from './connection.js';
import { updatePanel, panelInvalidate } from './ui/window.js';
import { ensureLauncher } from './ui/launcher.js';

// Permanent registrations live for the whole page. Re-running init() on every
// enable used to call addCommandObject/registerDebugFunction again — harmless
// on current ST (they overwrite by name) but wasteful and fragile if a future
// build appends instead. Track what's already succeeded and only retry the
// APIs that were unavailable last time.
let _slashRegistered = false;
let _debugRegistered = false;
const _debugIds = new Set();

// ══════════════════════════════════════════════════════════════════════════════
// SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Register three flat /glosses_* slash commands (spec §4.1).
 *
 * The previous single `SlashCommand.fromProps({ name: 'glosses',
 * subcommands: [...] })` NEVER worked: `SlashCommand` has no `subcommands`
 * field (verified SlashCommand.js:54-63), and `SlashCommandParser` stores
 * commands flat (SlashCommandParser.js:44,95). Every `/glosses <verb>`
 * invocation therefore landed on the parent command's `callback`, which was
 * `undefined` — ST either logged a TypeError or no-oped. Power-user command
 * surface was silently dead.
 *
 * Rewrite as three flat commands. Callback bodies copied 1:1 from the old
 * subcommands. `/glosses_toggle` also calls `ensureLauncher()` so the QR-bar
 * launcher tracks the new state immediately (closes products §6.8's
 * stale-launcher half) — otherwise the launcher lingered until the next
 * chat switch.
 *
 * The `ui/launcher.js` import does NOT create a cycle (launcher.js imports
 * from core.js + icons.js + dynamic-imports window.js only — never commands.js).
 */
export function registerSlashCommands() {
    if (_slashRegistered) return;
    try {
        const ctx = getCtx();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'glosses_toggle',
            helpString: 'Toggle Glosses footnotes on/off',
            callback: () => {
                S().enabled = !S().enabled;
                saveSettings();
                // UI sync only when the runtime is actually up: the
                // registration outlives a disable (ST keeps slash commands for
                // the page lifetime), and toggling a torn-down extension used
                // to re-mount the launcher / re-inject markers with events
                // unbound — a half-alive state.
                if (state.runtimeActive) {
                    if (S().enabled) restoreHighlightsAll();
                    else {
                        document.querySelectorAll('.mes[mesid]').forEach(el => removeHighlights(el));
                    }
                    // Keep the QR-bar launcher in sync with the new state so a
                    // disable via slash-command removes the button immediately
                    // (otherwise it lingered until the next chat switch).
                    try { ensureLauncher(); } catch { /* non-critical */ }
                }
                return S().enabled ? 'Glosses enabled' : 'Glosses disabled';
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'glosses_regen',
            helpString: 'Regenerate footnotes for the last message',
            callback: () => {
                if (!S().enabled || !state.runtimeActive) return 'Glosses is disabled';
                const ctx2 = getCtx();
                const msgIds = _allAnnotatableMsgIds(ctx2);
                const lastId = msgIds[msgIds.length - 1];
                if (!lastId) return 'No annotatable messages in this chat';
                const msg = ctx2.chat?.[parseInt(lastId)];
                if (!msg) return 'Message not found';
                const swipeIdx = msg.swipe_id ?? 0;
                const mesEl = document.querySelector(`.mes[mesid="${lastId}"]`);
                generateFootnotes(lastId, swipeIdx, mesEl);
                return 'Regenerating footnotes…';
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'glosses_clear',
            helpString: 'Clear all footnotes cache for the current chat',
            callback: () => {
                if (!state.runtimeActive) return 'Glosses is disabled';
                clearAll();
                document.querySelectorAll('.mes[mesid]').forEach(el => removeHighlights(el));
                panelInvalidate();
                updatePanel();
                return 'Footnotes cache cleared';
            },
        }));

        log('Slash commands registered.');
        _slashRegistered = true;
    } catch (e) { warn('Failed to register slash commands:', e); }
}

// "Annotatable" = AI messages, OR (when S().glossUserMessages is on) user
// messages too. System messages are never annotatable. Used by /glosses_regen
// to pick the last eligible message regardless of author.
function _allAnnotatableMsgIds(ctx) {
    if (!ctx.chat) return [];
    const allowUser = S().glossUserMessages;
    return ctx.chat
        .map((msg, i) => ({ msg, i }))
        .filter(({ msg }) => msg && !msg.is_system && (allowUser ? true : !msg.is_user))
        .map(({ i }) => String(i));
}

// ══════════════════════════════════════════════════════════════════════════════
// DEBUG FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

export function registerDebugFunctions() {
    try {
        const ctx = getCtx();
        const { registerDebugFunction } = ctx;
        if (!registerDebugFunction) return;

        // Each id is registered at most once for the life of the page. If a
        // previous init pass failed mid-way (e.g. threw before the second id
        // landed), only the missing ids are retried on the next pass.
        if (!_debugIds.has('gls_cache_info')) {
            registerDebugFunction(
                'gls_cache_info',
                'Glosses: Cache Info',
                'Show cache statistics for the current chat',
                () => {
                    const s = stats();
                    if (!s.entries) return { ok: true, message: 'No cache.' };
                    return {
                        ok: true,
                        message: `Variants glossed: ${s.entries}, total footnotes: ${s.footnotes}`,
                    };
                },
            );
            _debugIds.add('gls_cache_info');
        }

        if (!_debugIds.has('gls_clear_cache')) {
            registerDebugFunction(
                'gls_clear_cache',
                'Glosses: Clear Cache',
                'Delete all cached footnotes for the current chat',
                () => {
                    clearAll();
                    panelInvalidate();
                    updatePanel();
                    return { ok: true, message: 'Glosses cache cleared.' };
                },
            );
            _debugIds.add('gls_clear_cache');
        }
        if (!_debugIds.has('gls_toggle_debug_capture')) {
            registerDebugFunction(
                'gls_toggle_debug_capture',
                'Glosses: Toggle Debug Capture',
                'When ON, lastCustomEndpointDebug keeps full request/response bodies (prompt text included); when OFF (default) only metadata (URL, model, char counts) is kept.',
                () => {
                    const next = !(S().debugMode === true);
                    S().debugMode = next;
                    saveSettings();
                    if (!next) {
                        // Turning capture off drops whatever full bodies the
                        // last debug-mode request left in memory.
                        lastCustomEndpointDebug.request = null;
                        lastCustomEndpointDebug.response = null;
                        lastCustomEndpointDebug.error = null;
                    }
                    return { ok: true, message: `Debug capture ${next ? 'ON — full bodies retained' : 'OFF — metadata only'}.` };
                },
            );
            _debugIds.add('gls_toggle_debug_capture');
        }
        _debugRegistered = _debugIds.size === 3;
    } catch (e) { warn('Failed to register debug functions:', e); }
}

// ── Test-only hooks (gated on NODE_TEST) ──
// The registration flags model "permanent for the life of the page", which is
// exactly the contract we want at runtime but makes per-test verification
// awkward (modules are cached, so the flag persists across tests in a file).
// Expose a reset so tests can assert the registration lifecycle from a clean
// state. Mirrors the generator.js _test* convention.
//
// NOTE: read `process` via globalThis (same rule as generator.js:940-945).
// The bare `process?.env` form throws ReferenceError in the browser — `process`
// is a Node-only global, and optional chaining only guards against
// null/undefined values, NOT against undeclared identifiers. In a browser this
// line sat at module top level, so the whole module graph failed to evaluate
// and the extension never started (surfaced as a hook-activate error).
export const _test = (globalThis.process?.env?.NODE_TEST === '1') ? {
    resetRegistrations() {
        _slashRegistered = false;
        _debugRegistered = false;
        _debugIds.clear();
    },
    registrationState() {
        return {
            slash: _slashRegistered,
            debug: _debugRegistered,
            debugIds: [..._debugIds],
        };
    },
} : null;
