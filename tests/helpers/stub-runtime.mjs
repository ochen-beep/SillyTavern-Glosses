// @ts-check
/**
 * Minimal SillyTavern / DOM runtime stub for Node-side unit tests.
 *
 * Ported from DS Comments/test-helpers/stub-runtime.mjs, adapted for the
 * symbols Glosses' src modules actually touch at top-level eval and in pure
 * (non-DOM) code paths:
 *
 *   - core.js line ~363 creates `document.createElement('div')` at module-eval
 *     time and stores it in `_plainTextDiv` (used by extractPlainText). The
 *     returned element must support settable `innerHTML` + gettable
 *     `innerText`/`textContent` (tag-stripped, no layout).
 *   - core.js loadSettings() calls `SillyTavern.libs.lodash.merge(...)`.
 *   - cache.js / generator.js read `getCtx().chat` / `.chatMetadata` /
 *     `.extensionSettings` / `.saveMetadata` etc. via `SillyTavern.getContext()`.
 *   - core.js getApiKey/setApiKey use `SillyTavern.libs.localforage`.
 *
 * Load this file FIRST in every test (side-effecting import), BEFORE importing
 * any src/*.js — otherwise the module crashes at top-level eval.
 *
 * Intentionally no jsdom: the only DOM consumer in pure modules is
 * extractPlainText, which is covered by a hand-rolled tag-strip. DOMPurify is
 * stubbed as identity — XSS contracts are tested via the renderer's own
 * escapeHtml (and a dedicated sanitize test under real DOMPurify is out of
 * scope for Node-side unit tests).
 */

// ── document shim (only what pure modules touch) ──
function makeEl() {
    return {
        _html: '',
        set innerHTML(v) { this._html = String(v ?? ''); },
        get innerHTML() { return this._html; },
        // A live DOM's innerText/textContent strip tags; replicate without layout.
        get innerText() { return this._html.replace(/<[^>]+>/g, ''); },
        // textContent is both read (tag-stripped) and written (extractPlainText
        // clears it after use), so it needs a setter too.
        get textContent() { return this._html.replace(/<[^>]+>/g, ''); },
        set textContent(v) { this._html = String(v ?? ''); },
    };
}
globalThis.document = {
    createElement: () => makeEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    // removeLauncher() toggles the launcher-mounted marker class on <body>.
    body: { classList: { add() {}, remove() {} } },
};

// ── window shim ──
globalThis.window = {
    confirm: () => true,
    prompt: () => null,
};

// ── toastr shim (core.js catch blocks call toastr?.error?.(...)) ──
globalThis.toastr = { error: () => {}, info: () => {}, success: () => {}, warning: () => {} };

// ── fetch shim ──
// loadPromptStyle / buildContextBlocks fetch bundled prompts/*.md via an
// ST-relative URL derived from import.meta.url. Under Node that path is not
// resolvable (and on Windows it's malformed), so return a synthetic 404: the
// callers treat !resp.ok as "no style prompt" and fall back to the base system
// prompt. Tests that need real prompt content can override globalThis.fetch.
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });

// ── SillyTavern mock ──
// Context object tests mutate per-case (chat, extensionSettings…).
globalThis._stCtx = {
    chat: [],
    chatMetadata: {},
    extensionSettings: {},
    maxContext: 16384,
    chatId: 'test-chat',
    saveSettingsDebounced: () => {},
    saveMetadata: () => {},
    saveChat: () => {},
    substituteParams: (t) => t,
};

globalThis.SillyTavern = {
    libs: {
        lodash: {
            // identity-debounce: tests need synchronicity, not throttle.
            // Attach a flush() that invokes the wrapped function so callers
            // can await completion the same way lodash debounce allows.
            debounce: (fn) => {
                const wrapped = (...args) => fn(...args);
                wrapped.flush = () => fn();
                return wrapped;
            },
            cloneDeep: (o) => JSON.parse(JSON.stringify(o)),
            merge: (a, b) => ({ ...a, ...b }),
        },
        // identity-sanitize: XSS contracts are tested via renderer's escapeHtml.
        DOMPurify: { sanitize: (html) => html },
        localforage: {
            getItem: async () => null,
            setItem: async () => {},
            removeItem: async () => {},
        },
    },
    getContext: () => globalThis._stCtx,
};

/** Reset the ST context between test cases (call in beforeEach for core tests). */
export function resetCtx(overrides = {}) {
    globalThis._stCtx = {
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        maxContext: 16384,
        chatId: 'test-chat',
        saveSettingsDebounced: () => {},
        saveMetadata: () => {},
        saveChat: () => {},
        substituteParams: (t) => t,
        ...overrides,
    };
}

/**
 * Build an ST-shaped chat message with aligned swipes/swipe_info, mirroring
 * what SillyTavern maintains (ensureSwipes/syncMesToSwipe/syncSwipeToMes):
 * swipe_info[i].extra is the per-variant slot Glosses' footnote payload lives
 * in, msg.extra is the live mirror for the shown variant.
 *
 * @param {{
 *   mes?: string, swipes?: string[], swipe_id?: number, is_user?: boolean,
 *   is_system?: boolean, is_hidden?: boolean, name?: string, noSwipeInfo?: boolean,
 * }} [opts]
 */
export function makeMessage(opts = {}) {
    const mes = opts.mes ?? '';
    const swipes = opts.swipes ?? [mes];
    const swipe_id = opts.swipe_id ?? 0;
    const msg = {
        name: opts.name ?? 'Char',
        mes: swipes[swipe_id] ?? mes,
        is_user: !!opts.is_user,
        is_system: !!opts.is_system,
        is_hidden: !!opts.is_hidden,
        send_date: 'today',
        swipe_id,
        swipes,
        extra: {},
    };
    if (!opts.noSwipeInfo) {
        msg.swipe_info = swipes.map(() => ({ send_date: 'today', gen_started: undefined, gen_finished: undefined, extra: {} }));
    } else {
        // User-style message: no swipe machinery at all.
        delete msg.swipe_id;
        delete msg.swipes;
        msg.mes = mes;
    }
    return msg;
}
