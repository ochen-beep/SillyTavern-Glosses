// @ts-check
/**
 * Glosses — Core module
 * Constants, default settings, runtime state, utilities, settings persistence,
 * path resolution, i18n, logging.
 *
 * Behaviour ported 1:1 from SillyTavern-Footnotes/src index.js. Only structure
 * changed: monolith split into modules per the DS Comments skeleton.
 */

export const MODULE_NAME = 'Glosses';
export const DISPLAY_NAME = 'Glosses';
export const LOG_PREFIX = '[Glosses]';

export const PANEL_LAYOUT_KEY = 'gls-panel-layout';
// 768 matches DS Comments and catches tablets / narrow desktop windows that
// the old 600 missed (those stayed in the desktop --side layout with the panel
// pinned to right:14px;top:50% and were partly off-screen → "can't see window").
export const MOBILE_BREAKPOINT = 768;

// Posts whose trimmed text is shorter than this (or equals the '...' streaming
// placeholder) are treated as ST generation placeholders, not real content -
// footnote generation is skipped for them (events.js false-start guard +
// cache.js fingerprint). Mirrors DS Comments' guard.
export const MIN_POST_LENGTH = 5;

// Chat-metadata key under ctx.chatMetadata for chat-scoped Glosses settings.
export const META_KEY = 'gls_data';

// Bundled sound used as the default value for settings.soundName. Kept here (not
// in sound.js) so DEFAULT_SETTINGS below can reference it without an import cycle
// (sound.js imports from core.js). Must match BUNDLED_SOUNDS[0].file in sound.js.
export const DEFAULT_SOUND_NAME = 'Tiny_minimalist_bubb_#4-1780921666702.wav';

// localforage key for the custom notification sound (a data-URL blob).
export const LF_CUSTOM_SOUND = `${MODULE_NAME}_custom_sound`;
// localforage key for the custom-endpoint API key (kept out of the settings JSON).
export const LF_API_KEY = `${MODULE_NAME}_apiKey`;

// ── Path resolution ──
// Resolve module path from import.meta.url so fetch() can address our own files
// (prompts/, sounds/, i18n/) regardless of where ST mounts third-party extensions.
const _metaUrl = new URL(import.meta.url);
const _metaPath = decodeURIComponent(_metaUrl.pathname);
export const BASE_URL = _metaPath.substring(1).replace(/\/src\/core\.js$/, '');
export const MODULE_PATH = BASE_URL.replace(/^scripts\/extensions\//, '');

/** URL prefix for addressing files shipped inside this extension. */
export function getExtBase() {
    return `/scripts/extensions/${MODULE_PATH}`;
}

// ── Logging ──
export const log   = (...a) => console.log(LOG_PREFIX, ...a);
export const warn  = (...a) => console.warn(LOG_PREFIX, ...a);
export const error = (...a) => console.error(LOG_PREFIX, ...a);

// ── SillyTavern context ──
export function getCtx() {
    return SillyTavern.getContext();
}

// ── Default Settings ──
// Frozen so accidental mutation of DEFAULTS at runtime throws in strict mode;
// loadSettings() deep-clones it before merging user values.
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoGenerate: true,
    // Allow footnotes on the user's own ({{user}}) posts. Off by default:
    // footnotes are primarily a literary device for the AI's prose. When on, a
    // per-message regenerate button (renderer.addRegenButton) is mounted on
    // user posts too, and the floating panel / scroll-observer / reindex /
    // anchor-policy include user posts. Generation stays MANUAL-only for user
    // posts (events.js never subscribes to USER_MESSAGE_RENDERED) - this flag
    // unlocks the button + the data paths, it does not auto-trigger anything.
    glossUserMessages: false,
    source: '',
    selectedProfile: '',
    promptStyle: 'pratchett50',
    customPrompt: '',
    // §6.1: short-name preset that bundles a few settings at once. Empty =
    // manual mode (no preset active; the user edits each field). Set via the
    // Presets dropdown at the top of the Prompt accordion. Selecting a
    // preset merges its fields into S(); any manual edit of those fields
    // clears selectedPreset back to ''.
    selectedPreset: '',
    // Language of footnote TEXT ('ru' | 'en'). Default 'ru' per user. Replaces
    // the old heuristic (document.documentElement.lang). See
    // 2026-07-02-glosses-anchor-count-language-design.md §3.
    outputLanguage: 'ru',
    maxFootnotes: 5,
    targetLanguage: 'en',
    cefrLevel: 'auto',
    // Hybrid footnote style (6th promptStyle): which lenses are active. The
    // Language lens reuses targetLanguage / cefrLevel above. See spec
    // 2026-07-02-glosses-hybrid-mode-design.md.
    hybridLenses: {
        language: true,
        pratchett: true,
        canon: true,
        academic: false,
        meta: false,
        // Canon Expansion: invents lore the canon leaves undefined (events,
        // names, characters — anything that fills the world without
        // contradicting canon/AU). Opt-in: it changes the footnote's nature
        // from explanation to invention, like academic/meta.
        expansion: false,
    },
    // Custom hybrid lenses (user-authored role snippets). Each entry:
    // { id, name, prompt, active }. `prompt` is a compact role (voice + what
    // to footnote + label + format quirk) — interpolated with {{OUTPUT_LANGUAGE}}
    // only (no lang/CEFR tokens). See spec / generator.js hybrid branch.
    customLenses: [],
    displayMode: 'both',
    highlightColor: '#ffe066',
    highlightOpacity: 40,
    highlightStyle: 'background',
    // Footnote font = the footnote TEXT as the chat surfaces render it: the
    // popup, the inline block and the settings popup snapshot. The floating
    // panel is a separate UI surface with its own pair below — mixing the two
    // (one font slider bending the whole panel chrome too) read as a bug.
    footnoteFontFamily: 'inherit',
    footnoteFontSize: '0.9em',
    panelFontFamily: 'inherit',
    panelFontSize: '0.9em',
    markerFontSize: '0.75em',
    // Popup: max width cap (px) and whether the action header (Copy/Edit/
    // Delete/Close) renders. With the header off, the popup still closes via
    // Escape / outside click / marker toggle; Copy/Edit/Delete remain in the
    // floating panel rows.
    popupMaxWidth: 420,
    popupShowHeader: true,
    // Vertical placement preference for the footnote popup: 'auto' = side
    // with more free viewport space, 'below'/'above' = pinned (still flips
    // to the opposite side when the pinned side can't fit the popup).
    popupPosition: 'auto',
    // Popup appearance knobs (Level 1 — orthogonal to skins):
    // - popupCornerRadius: border-radius in px. 12 reproduces the historic
    //   --gls-radius-lg look; 0 = square "slab", 18+ = soft bubble.
    // - popupDensity: body padding + line-height. 'comfortable' = historic
    //   sp-3/sp-4/sp-2 paddings; 'compact' saves vertical space (mobile,
    //   long footnotes).
    // - popupShadow: 'strong' = the wide float halo (historic), 'soft' = a
    //   shorter lighter pair for light themes where big shadows read dirty,
    //   'none' = flat.
    popupCornerRadius: 12,
    popupDensity: 'comfortable',
    popupShadow: 'strong',
    // Popup skin (Level 2 — color + decoration bundles): 'adaptive' keeps the
    // theme-derived surface/edge (historic behavior); the others override the
    // popup's color tokens with a fixed palette and layered background
    // decorations via .gls-popup-skin-* classes — 'paper', 'terminal',
    // 'telegram', 'bubble', plus the v2 set 'glass' (frosted translucency),
    // 'codex' (illuminated manuscript) and 'neon' (charged night rim). Skins
    // never touch radius/density/shadow — those stay with the knobs above —
    // and their font applies only while footnoteFontFamily is 'inherit' (an
    // explicit font choice always wins over the skin).
    popupTheme: 'adaptive',
    // Level-3 styling layer (src/ui/custom-css.js): raw user CSS injected as
    // a <style> tag ON TOP of tokens + skins. '' = nothing injected.
    // customCssEnabled lets the user park the text while switching the layer
    // off temporarily. Coerced on load (below) like the other enum guards.
    customCss: '',
    customCssEnabled: true,
    // Window invocation control: 'bar' (quick-reply bar button) | 'floating'
    // (draggable FAB, src/ui/floating-launcher.js) | 'both'. Validated on load.
    launcherMode: 'bar',
    floatingPanelEnabled: false,
    // Persisted ✕-hide: the user's hidden/shown choice for the floating panel.
    // Set by the panel's ✕ button, cleared by the launcher re-show / any enable
    // path. Survives page reloads and server restarts (it rides the regular
    // extension settings), replacing the old session-only display:none hide.
    floatingPanelHidden: false,
    soundEnabled: true,
    soundVolume: 30,
    // soundName: a bundled filename OR '__custom__' (a data-URL blob in
    // localforage under LF_CUSTOM_SOUND). This is the value the UI (settings-sync)
    // and playback (sound.js) actually read/write.
    soundName: DEFAULT_SOUND_NAME,
    // Sound scheme (3.6): soundId is 'folder:<bundled file>' or 'custom_<n>'
    // (a SERVER-side upload in data/<user>/user/files/, see user-files.js);
    // soundFiles holds the display/file metadata per custom key. soundName is
    // legacy, kept only as the one-time migration input (sound.js).
    soundId: '',
    soundFiles: {},

    // §3 custom-endpoint source (OpenAI-compatible chat completions).
    customEndpoint: '',
    customModel: '',
    // Origins the user explicitly confirmed for a non-loopback HTTP custom
    // endpoint (plan stage 8). Plain https endpoints never need confirming;
    // loopback http is allowed with a warning. Persisted so the confirmation
    // survives reloads instead of re-asking on every request.
    customEndpointAllowlist: [],
    // Debug capture (port of DS Comments debugMode). When false (default),
    // lastCustomEndpointDebug keeps only metadata (URL, model, char counts) —
    // full prompt/response bodies would otherwise sit in memory for the whole
    // page lifetime. Toggled via the Debug Menu "Glosses: Toggle Debug Capture".
    debugMode: false,

    stopWords: '',
    avoidRepeatedAnchors: true,
    activePanelTab: 'footnotes',
    contextDepth: 0,
    includeCharacterCard: false,
    includePersona: false,
    includeLorebook: false,
});

// ── Runtime State ──
// Single mutable settings object reference. Updated in place by settings-sync
// and read everywhere via import. Re-assigned wholesale by loadSettings().
export const state = {
    settings: {},                  // active settings (DEFAULTS ⊕ user)
    abortControllers: {},          // { messageId: AbortController }
    isGenerating: {},              // { messageId: boolean }
    promptCache: {},               // { 'style:locale' | 'language:...' : promptText }
    panelFocusMsgId: null,         // messageId (string) the floating panel shows
    cachedAnnotatableMsgIds: null, // memoized list of annotatable message ids (AI, or AI+user when glossUserMessages is on). Invalidated on chat/edit/delete.
    // Generation-epoch staleness guard. ST generateRaw/quietPrompt accept no
    // AbortSignal and don't auto-cancel on chat switch, so a completion from
    // chat A can land in chat B. Callers snapshot beginGenerationEpoch() at the
    // start of a generation and check isEpochCurrent() before rendering/
    // persisting the result. Bumped by onChatChanged. Ported from DS Comments.
    generationEpoch: 0,
    // WORLD_INFO_ACTIVATED stash for per-chat automatic lore (lorebooks.js):
    // `pending` lands when ST finishes its prompt build (the annotated message
    // is not pushed yet); events.js claims it on CHARACTER_MESSAGE_RENDERED
    // and binds msgId/swipeIdx into `lastActivatedWorldInfo`.
    pendingActivatedWorldInfo: null,
    lastActivatedWorldInfo: null,
    // C3: auto-generation warns ONCE per unconfigured episode, then stays silent
    // until a generation actually succeeds (which clears this). Manual regenerate
    // is unaffected - it toasts every time. See events.js#autoGenerateIfConfigured.
    configWarned: false,
    // §6.4: latest known source-configured state. Re-written on every
    // autoGenerateIfConfigured re-check AND on every generateFootnotes
    // catch block so manual-regen failures surface too. Consulted by
    // renderPanel so the floating panel can show a PERSISTENT "Source not
    // configured" badge instead of silently idling after the first toast.
    // Toast one-shot is still governed by configWarned above.
    configuredState: { ok: true, reason: '' },
    // True between a completed init() and cleanup(). Slash commands outlive a
    // disable (ST keeps registrations for the page lifetime) and consult this
    // flag so a disabled extension's UI is never mutated from a command.
    runtimeActive: false,
};

// Convenience alias matching the original codebase's `S` reference.
export function S() {
    return state.settings;
}

// ── Generation-epoch guard (staleness for cross-chat generation races) ──
// Ported from DS Comments. ST generateRaw/quietPrompt accept no AbortSignal and
// don't auto-cancel on chat switch, so a completion from chat A can land in
// chat B. Callers snapshot beginGenerationEpoch() at the start of a generation
// and check isEpochCurrent() before rendering/persisting the result.

/** Increment the epoch, invalidating any in-flight generation's snapshot. */
export function bumpGenerationEpoch() {
    state.generationEpoch++;
}

/**
 * Snapshot the current epoch to use as a staleness token.
 * Call exactly once, at the start of a generation, BEFORE any await.
 * @returns {number} opaque token — pass to isEpochCurrent() later.
 */
export function beginGenerationEpoch() {
    return state.generationEpoch;
}

/**
 * Is the snapshot token still the active epoch?
 * @param {number} token — value returned by beginGenerationEpoch()
 * @returns {boolean} false → the generation result must be discarded.
 */
export function isEpochCurrent(token) {
    return token === state.generationEpoch;
}

// ── Settings persistence ──
export function loadSettings() {
    const ctx = getCtx();
    state.settings = SillyTavern.libs.lodash.merge(
        structuredClone(DEFAULT_SETTINGS),
        ctx.extensionSettings[MODULE_NAME] || {},
    );
    let settingsChanged = false;
    // §3 source enum — guard against stale/hand-edited values.
    // 'default' (the old ST-API passthrough) was removed: it routed footnote
    // generation through the main LLM pipeline, picking up presets, instruct
    // formatting and other extensions' injections, which broke the strict
    // JSON/footnote output contract. Only isolated sources remain.
    if (!['profile', 'custom'].includes(state.settings.source)) {
        state.settings.source = '';
    }
    if (!['ru', 'en'].includes(state.settings.outputLanguage)) {
        state.settings.outputLanguage = DEFAULT_SETTINGS.outputLanguage;
        settingsChanged = true;
    }
    // Launcher mode enum — guard against stale/hand-edited values.
    if (!['bar', 'floating', 'both'].includes(state.settings.launcherMode)) {
        state.settings.launcherMode = DEFAULT_SETTINGS.launcherMode;
        settingsChanged = true;
    }
    // Hybrid ALL became a manual configuration; retain every setting it applied.
    if (state.settings.selectedPreset === 'hybrid-all-ru') {
        state.settings.selectedPreset = '';
        settingsChanged = true;
    }
    // Hybrid lenses — guard against stale/hand-edited values: ensure the
    // object and all 6 boolean keys exist. A partially-saved object from an
    // older Glosses version gets the missing keys filled from DEFAULTS.
    if (typeof state.settings.hybridLenses !== 'object' || state.settings.hybridLenses === null) {
        state.settings.hybridLenses = {};
    }
    for (const k of ['language', 'pratchett', 'canon', 'academic', 'meta', 'expansion']) {
        if (typeof state.settings.hybridLenses[k] !== 'boolean') {
            state.settings.hybridLenses[k] = DEFAULT_SETTINGS.hybridLenses[k];
        }
    }
    // Custom hybrid lenses — coerce to [{id,name,prompt,active}].
    if (!Array.isArray(state.settings.customLenses)) {
        state.settings.customLenses = [];
    }
    state.settings.customLenses = state.settings.customLenses
        .map(c => (c && typeof c === 'object') ? c : {})
        .map(c => ({
            id:     typeof c.id === 'string' && c.id ? c.id : '',
            name:   typeof c.name === 'string' ? c.name : '',
            prompt: typeof c.prompt === 'string' ? c.prompt : '',
            active: typeof c.active === 'boolean' ? c.active : true,
        }))
        // Drop entries with no id AND no name — unselectable junk from a
        // hand-edit or a partial save.
        .filter(c => c.id || c.name);
    // Popup custom CSS layer — coerce junk from hand-edited settings: the CSS
    // must be a string and the toggle a boolean (mirrors the launcherMode
    // guard above; a repaired value persists via settingsChanged).
    if (typeof state.settings.customCss !== 'string') {
        state.settings.customCss = '';
        settingsChanged = true;
    }
    if (typeof state.settings.customCssEnabled !== 'boolean') {
        state.settings.customCssEnabled = true;
        settingsChanged = true;
    }
    // Sound scheme (3.6): coerce soundId/soundFiles types. The authoritative
    // normalizer lives in sound.js (normalizeSoundFiles) — this inline pass
    // only guards types to avoid a core↔sound import cycle.
    if (typeof state.settings.soundId !== 'string') state.settings.soundId = '';
    if (!state.settings.soundFiles || typeof state.settings.soundFiles !== 'object') {
        state.settings.soundFiles = {};
    } else {
        const files = {};
        for (const [k, v] of Object.entries(state.settings.soundFiles)) {
            if (/^custom_\d+$/.test(k) && v && typeof v === 'object' && typeof v.file === 'string' && v.file) {
                files[k] = { name: (typeof v.name === 'string' && v.name) ? v.name : k, file: v.file };
            }
        }
        state.settings.soundFiles = files;
    }
    ctx.extensionSettings[MODULE_NAME] = state.settings;
    if (settingsChanged) ctx.saveSettingsDebounced();
}

export function saveSettings() {
    const ctx = getCtx();
    ctx.extensionSettings[MODULE_NAME] = state.settings;
    ctx.saveSettingsDebounced();
}

/**
 * Best-effort settings persist on page-hide / drag-end, bypassing the
 * debounced wrapper for an IMMEDIATE write so a tab close within the
 * ~0.5–1s debounce window no longer loses the most recent mutation.
 *
 * Background (spec §4.5): ST's `saveSettingsDebounced` is a plain
 * closure from utils.js#debounce with NO .flush()/.cancel()/.pending()
 * (those are lodash-only). `saveSettings()` above calls it, which only
 * re-arms the timer. The previous `flushSettings()` therefore also only
 * re-armed the timer — misleading name and silent data loss on tab close.
 *
 * Fix: import ST's root-level (non-debounced) `saveSettings` from
 * `public/script.js` and call it on hide. Path from a third-party
 * extension's src/core.js:
 *   ../../../../../script.js  (5 ../ hops: src → <ext> → third-party →
 *   extensions → scripts → public), then /script.js
 * Confirmed via script.js:8025 (`export async function saveSettings(loopCounter = 0)`).
 * Falls back to the debounced `saveSettings()` wrapper for any ST build
 * where the import fails (worst case identical to pre-v3.1 behaviour).
 */
let _saveSettingsImmediate = null;
async function _getImmediateSave() {
    if (_saveSettingsImmediate) return _saveSettingsImmediate;
    try {
        const mod = await import('../../../../../script.js');
        _saveSettingsImmediate = (typeof mod.saveSettings === 'function')
            ? mod.saveSettings
            : null;
    } catch { _saveSettingsImmediate = null; }
    return _saveSettingsImmediate;
}

export async function flushSettings() {
    const ctx = getCtx();
    ctx.extensionSettings[MODULE_NAME] = state.settings;
    const immediate = await _getImmediateSave();
    if (immediate) {
        try { await immediate.call(ctx); return; } catch { /* fall back */ }
    }
    // Fallback: re-arm the debounce (current pre-v3.1 behaviour) — better
    // than nothing for older/forked ST builds where the import failed.
    ctx.saveSettingsDebounced();
}

// ── Custom-endpoint API key (localforage; kept out of the settings JSON) ──

export async function getApiKey() {
    try {
        return (await SillyTavern.libs.localforage.getItem(LF_API_KEY)) || '';
    } catch { return ''; }
}

export async function setApiKey(key) {
    try {
        if (key) await SillyTavern.libs.localforage.setItem(LF_API_KEY, key);
        else     await SillyTavern.libs.localforage.removeItem(LF_API_KEY);
    } catch { /* non-critical */ }
}

// ── Confirmation / Input modals (ST Popup, native fallback) ──
// Prefer the public ST surface (ctx.Popup / ctx.POPUP_RESULT) over importing
// ST internals, which break whenever ST reorganises its module layout.

// Deduplicated user notification (ported from DS Comments core.js). Toast
// storms on recurring events (per-message saves, per-message generation)
// are unreadable — a dedupeKey-bound 5 s window collapses them into one
// visible message. Returns true when the toast was actually shown.
const _notificationTimes = new Map();
export function notifyUser(level, message, dedupeKey = message) {
    const now = Date.now();
    if (now - (_notificationTimes.get(dedupeKey) || 0) < 5000) return false;
    _notificationTimes.set(dedupeKey, now);
    globalThis.toastr?.[level]?.(message, DISPLAY_NAME);
    return true;
}

export async function showConfirmModal(message) {
    try {
        const ctx = getCtx();
        // Gate on both surfaces: a partial API (Popup.show.confirm without
        // POPUP_RESULT) would make result === undefined silently return false on
        // every confirm. Falling back to native confirm is safer than a no-op.
        if (ctx?.Popup?.show?.confirm && ctx?.POPUP_RESULT?.AFFIRMATIVE) {
            const result = await ctx.Popup.show.confirm(t('Confirm'), message);
            const AFFIRMATIVE = ctx.POPUP_RESULT.AFFIRMATIVE;
            return result === AFFIRMATIVE;
        }
    } catch { /* fall through to native confirm */ }
    return window.confirm(message);
}

// Returns the entered string, or null if the user cancelled/blanked out.
export async function showInputModal(message, defaultValue = '') {
    try {
        const ctx = getCtx();
        if (ctx?.Popup?.show?.input) {
            const result = await ctx.Popup.show.input(t('Input'), message, defaultValue);
            if (typeof result === 'string' && result.trim()) return result.trim();
            return null;
        }
    } catch { /* fall through to native prompt */ }
    const raw = window.prompt(message, defaultValue);
    return raw && raw.trim() ? raw.trim() : null;
}

// ── i18n ──
// ST auto-loads the i18n JSON declared in manifest.json at activation
// (addExtensionLocale in extensions.js + addLocaleData in i18n.js), so we
// do NOT re-fetch it here. JS-side translation uses ST's official
// `translate(text, key=null)` from public/scripts/i18n.js (verified export
// at release/public/scripts/i18n.js:101). data-i18n attributes in
// settings.html are translated by ST's MutationObserver in i18n.js, so
// they share the same locale data as our JS-side t() after this unifies.
//
// Path from a third-party extension's src/core.js to public/scripts/i18n.js:
//   ../../../../i18n.js  (4 ../ hops: src → <ext> → third-party → extensions → scripts)
//
// We resolve official translate WITHOUT a top-level await so core.js can keep
// loading synchronously (top-level await would block every module that
// imports core.js until i18n.js resolves — bad for UI init). Instead we
// kick off the resolution eagerly and let t() use the identity fallback
// until the Promise resolves (microseconds to milliseconds).

let _translateFn = null;
let _translateReady = false;

/** Lazy resolver — starts the ESM import + global-fallback chain. Memoises
 *  the first successful surface (official ESM `translate`, then the
 *  `SillyTavern.translate` global, then identity). Resolves null if both
 *  miss. Idempotent — safe to call multiple times. */
function _resolveTranslate() {
    if (_translateReady) return;
    _translateReady = true;
    import('../../../../i18n.js')
        .then((mod) => {
            if (typeof mod?.translate === 'function') _translateFn = mod.translate;
        })
        .catch(() => { /* fall through to global */ });
    // Also pre-cache the global fallback — checked inside t() until the
    // import settles (and again if the import rejected).
}

/** Translate a key, falling back to the key itself. Positional {0}, {1}, …
 *  placeholders are replaced with the extra args via split/join (so args
 *  containing '$' or '&' are not misread as replacement patterns). Wraps
 *  ST's official `translate(text, key=null)` from scripts/i18n.js; until
 *  the resolver settles (or if both ESM + global surfaces are absent) the
 *  identity fallback keeps Glosses working with English labels — degraded
 *  but never crashing (spec §5.1). */
export function t(key, ...args) {
    if (!_translateReady) _resolveTranslate();
    let fn = _translateFn;
    if (!fn && typeof SillyTavern?.translate === 'function') {
        fn = SillyTavern.translate;
        // Latch so we don't pay the global lookup on every call.
        _translateFn = fn;
    }
    let s = fn ? (fn(key, key) ?? key) : key;
    if (args.length) {
        for (let i = 0; i < args.length; i++) {
            s = s.split(`{${i}}`).join(args[i]);
        }
    }
    return s;
}

// ── Shared mutable DOM helper ──
// Reusable offscreen div for HTML → plain text extraction. Avoids creating a
// throwaway element per call (extractPlainText is hot during prompt building).
const _plainTextDiv = document.createElement('div');

export function extractPlainText(htmlString) {
    // Strip ST custom noise tags that innerHTML→innerText would otherwise
    // leave visible as literal text in both the annotation target and the
    // background block. TPBR banners are intentionally KEPT — they describe
    // the scene and the words inside them are valid post-text substrings.
    // See spec 2026-07-02-glosses-context-separation-design.md §6.
    const raw = String(htmlString || '')
        .replace(/\[think][\s\S]*?\[\/think]/gi, '')
        .replace(/\[ILST:[^\]]*]/gi, '');
    _plainTextDiv.innerHTML = raw;
    const text = (_plainTextDiv.innerText || _plainTextDiv.textContent || '').trim();
    _plainTextDiv.textContent = '';
    return text;
}

// ── Misc utilities ──
export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escRe = /[&<>"']/g;
/** HTML-escape a string for safe insertion into textContent or as an attribute. */
export function escapeHtml(str) {
    return String(str ?? '').replace(_escRe, ch => _escMap[ch]);
}

// ── DOMPurify Sanitize (with LRU cache) ──
// Ported from DS Comments/core.js. Used by renderer.formatFootnoteText before
// mini-markdown → innerHTML, so a prompt-injected model can't emit tracking
// pixels (<img>), phishing links (<a>), media embeds, or scripts into footnote
// bodies. The footnote mini-markdown only produces div/span/strong/em/code/
// del/br, so legitimate output is unchanged.
const _sanitizeCache = new Map();
const _sanitizeMax = 64;
export function sanitize(html) {
    try {
        if (_sanitizeCache.has(html)) {
            const v = _sanitizeCache.get(html);
            _sanitizeCache.delete(html);
            _sanitizeCache.set(html, v);   // LRU: bump to most-recent
            return v;
        }
        const clean = SillyTavern.libs.DOMPurify.sanitize(html, {
            FORBID_TAGS: ['img', 'a', 'video', 'audio', 'source', 'iframe', 'object', 'embed'],
        });
        if (_sanitizeCache.size >= _sanitizeMax) {
            _sanitizeCache.delete(_sanitizeCache.keys().next().value);   // evict oldest
        }
        _sanitizeCache.set(html, clean);
        return clean;
    } catch {
        // Fail closed: never return raw model HTML to innerHTML. Escape it so
        // mini-markdown still works (asterisks/backticks aren't escaped) while
        // any <img onerror=...> / <script> the model emitted becomes inert text.
        return escapeHtml(html);
    }
}

