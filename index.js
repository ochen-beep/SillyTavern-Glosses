// @ts-check
/**
 * Glosses — Literary footnotes for SillyTavern
 * v3.1.0 — ST-contract fixes + product simplification (slash commands, inline
 * displayMode, presets, persistent source badge, etc.).
 * v3.0.0 — modular refactor of SillyTavern-Footnotes.
 *
 * This file is the thin orchestrator: lifecycle hooks + initialization order.
 * All logic lives in src/ modules.
 *
 * Lifecycle hooks (manifest.json):
 *   activate → init()   (page load, extension activated)
 *   enable   → init()   (re-enabled; page reloads anyway in modern ST)
 *   disable  → cleanup()
 *   update   → (reserved for schema migrations)
 *   clean    → wipe cache + custom sound
 */

import {
    state, MODULE_NAME, DISPLAY_NAME, META_KEY, LF_CUSTOM_SOUND,
    loadSettings, saveSettings, flushSettings,
    getCtx, log, warn, error, t,
} from './src/core.js';
import {
    applyHighlightStyles, removeHighlights, closePopup,
    uninstallMarkerDelegation, resetLazyInjector,
} from './src/renderer.js';
import {
    destroyPanel, updatePanel, initViewportSync, disconnectViewportSync,
    clearTargetedTabState,
} from './src/ui/window.js';
import {
    bindEvents, unbindEvents, initScrollObserver, disconnectScrollObserver,
} from './src/events.js';
import { flushMetadata, clearAll } from './src/cache.js';
import { bindSettingsUI, unbindSettingsUI } from './src/ui/settings-sync.js';
import { initThemeSync, disconnectThemeSync } from './src/ui/theme-sync.js';
import { initIconSprite } from './src/ui/icons.js';
import { ensureLauncher, observeQrBar, removeLauncher } from './src/ui/launcher.js';
import { initSound } from './src/sound.js';
import { removeCustomCssTags, closeCssEditor } from './src/ui/custom-css.js';
import {
    registerSlashCommands, registerDebugFunctions,
} from './src/commands.js';
import { createInitializationController } from './src/runtime/lifecycle.js';

// ══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE HOOKS (exported for manifest.json)
// ══════════════════════════════════════════════════════════════════════════════

export async function onActivate() {
    log('onActivate: initializing…');
    try {
        await _runtime.start();
    } catch (e) {
        error('init error:', e);
    }
}

export async function onDisable() {
    log('Disabled — cleaning up');
    _runtime.stop();
    try { cleanup(); } catch (e) { error('cleanup error:', e); }
}

export async function onEnable() {
    log('onEnable: re-initializing…');
    try {
        await _runtime.start();
    } catch (e) {
        error('onEnable init error:', e);
    }
}

export async function onUpdate() {
    log('onUpdate: running data migrations…');
    // Reserved: migrate META_KEY schema here when its shape changes.
    // Example: if (store?.version < 3) migrateV2toV3(store);
}

export async function onClean() {
    log('Cleaning extension data');
    try { cleanup(); } catch (e) { error('cleanup error:', e); }
    try {
        const ctx = getCtx();
        // Remove every per-variant footnote payload (messages × swipe slots)
        // plus the legacy metadata store in one pass; clearAll schedules the
        // chat + metadata writers, which the flush below then persists so a
        // pending coalesced write cannot resurrect deleted data.
        clearAll({ clearPoolExcluded: true });
        if (ctx.chatMetadata?.[META_KEY]) {
            delete ctx.chatMetadata[META_KEY];
        }
        await flushMetadata();
    } catch (e) { error('cache cleanup error:', e); }
    try {
        const { localforage } = SillyTavern.libs;
        await localforage.removeItem(LF_CUSTOM_SOUND);
    } catch (e) { error('sound cleanup error:', e); }
}

// ══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

let _settingsPanelLoaded = false;
let _visibilityBound = false;
let _scrollInitTimer = null;

const _runtime = createInitializationController(init);

/**
 * Flush settings + chat metadata on page-hide. Hoisted to module scope (spec
 * §5.4) so cleanup() can removeEventListener it — the previous inline closure
 * escaped removal, keeping the handler firing on every page-hide after disable,
 * and _visibilityBound prevented re-binding on a later enable (immortal ghost).
 */
const _onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') return;
    flushSettings();
    // Bounded flush of the coalesced metadata writer (stage 5): persists any
    // pending saveMetadata work exactly once instead of re-invoking the host
    // save API directly (which could race an in-flight debounce).
    try { flushMetadata(); } catch { /* non-critical */ }
};

async function init(isCancelled = () => false) {
    if (isCancelled()) return;
    initIconSprite();
    loadSettings();
    // Async: legacy sound migration + server-side file verification. Never
    // blocks init; the settings dropdown refreshes itself when it finishes.
    initSound();
    if (isCancelled()) return;

    // ── Load the settings panel (once only — onActivate + onEnable both call init) ──
    if (!_settingsPanelLoaded) {
        try {
            const ctx = getCtx();
            if (ctx.renderExtensionTemplateAsync) {
                const innerHtml = await ctx.renderExtensionTemplateAsync(
                    _modulePath(), 'settings',
                );
                if (isCancelled()) return;
                jQuery('#extensions_settings').append(
                    `<div id="gls_settings_container" class="extension_block">
                        <div class="inline-drawer">
                            <div class="inline-drawer-toggle inline-drawer-header">
                                <b>${t('Glosses')}</b>
                                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                            </div>
                            <div class="inline-drawer-content">${innerHtml}</div>
                        </div>
                    </div>`,
                );
                _settingsPanelLoaded = true;
            }
        } catch (e) { warn('Could not load settings.html:', e); }
    }

    if (isCancelled()) return;
    applyHighlightStyles();
    // Force --gls-bg opaque (alpha=1) from ST's --SmartThemeBlurTintColor and
    // re-derive on live theme switches. Covers browsers the CSS-only @supports
    // relative-color fix doesn't (older engines, Samsung Internet). Spec §3.5.
    initThemeSync();
    bindSettingsUI();
    bindEvents();

    if (isCancelled()) return;
    // 📖 launcher button in the quick-reply bar + observer that re-mounts it
    // after ST rebuilds #send_form / #qr--bar (chat switch, group change, QR
    // edits). Must come after bindEvents so the chat-changed handler also
    // refreshes the launcher.
    ensureLauncher();
    observeQrBar();
    if (isCancelled()) return;

    // Live mobile↔desktop reflow on resize/rotate so the panel never gets
    // stuck in a layout that doesn't fit the viewport.
    initViewportSync();
    if (isCancelled()) return;

    if (state.settings.floatingPanelEnabled) {
        updatePanel();
        // Owned timer so cleanup() cancels it: a disable during the 0ms delay
        // previously still armed the observer after teardown.
        _scrollInitTimer = setTimeout(() => {
            _scrollInitTimer = null;
            initScrollObserver();
        }, 0);
    }

    // Flush pending settings + metadata when the page is about to hide —
    // prevents data loss if the user closes the tab right after generating.
    // Registered with the stable module-scope reference so cleanup() can
    // remove it and a later enable re-binds cleanly (spec §5.4).
    if (!_visibilityBound) {
        _visibilityBound = true;
        document.addEventListener('visibilitychange', _onVisibilityChange);
    }

    registerSlashCommands();
    registerDebugFunctions();

    log('Ready.');
}

// Resolve the ST-relative extension path for renderExtensionTemplateAsync.
// core.js exposes MODULE_PATH but re-deriving keeps this file decoupled.
function _modulePath() {
    const u = new URL(import.meta.url);
    const p = decodeURIComponent(u.pathname);
    const base = p.substring(1).replace(/\/index\.js$/, '');
    return base.replace(/^scripts\/extensions\//, '');
}

// ══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

function cleanup() {
    // Abort any running generations.
    for (const ctrl of Object.values(state.abortControllers)) ctrl.abort();
    for (const k of Object.keys(state.abortControllers)) delete state.abortControllers[k];
    for (const k of Object.keys(state.isGenerating)) delete state.isGenerating[k];

    // Cancel the deferred scroll-observer arming BEFORE tearing down the
    // observer itself — otherwise the 0ms timer fires after disconnect and
    // re-arms a dangling observer.
    if (_scrollInitTimer) { clearTimeout(_scrollInitTimer); _scrollInitTimer = null; }

    unbindEvents();
    unbindSettingsUI();
    disconnectScrollObserver();
    disconnectViewportSync();
    disconnectThemeSync();
    removeLauncher();
    uninstallMarkerDelegation();
    resetLazyInjector();
    closePopup();
    destroyPanel();
    clearTargetedTabState();
    // Close an open CSS editor dialog first (its close commits pending text
    // into settings), then strip the custom-CSS <style> tags — page-global
    // user CSS must not outlive its toggle after a disable/clean (same
    // contract as removeLauncher).
    closeCssEditor();
    removeCustomCssTags();

    // Unwrap every marker span in the chat (restore original text nodes).
    document.querySelectorAll('.gls-marker').forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        let txt = '';
        for (const child of span.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) txt += child.nodeValue;
        }
        parent.replaceChild(document.createTextNode(txt), span);
    });

    document.querySelectorAll('.gls-regen-btn').forEach(btn => btn.remove());
    document.getElementById('gls_settings_container')?.remove();
    _settingsPanelLoaded = false;

    // Remove the visibilitychange listener so a disabled extension stops
    // flushing settings on every page-hide (spec §5.4). Reset the guard so
    // the next enable re-binds the fresh module-scope handler cleanly.
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    _visibilityBound = false;
}
