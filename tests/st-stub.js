// Minimal SillyTavern stub for Node-side unit tests of pure modules.
// Reacts ONLY to the symbols parser.js / generator.js's hybrid branch
// / persona fallback actually touch. ST DOM/event/jQuery surfaces are
// NOT stubbed — those code paths are exercised by manual acceptance.

export const warn = (...a) => {}; // silent; tests assert on return values

export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Loader-wide: import parser.js against its real path but provide the
// above escapeRegex/warn as the ONLY `./core.js` deps parser needs.
// We do that by intercepting the dynamic import via a Node loader hook
// is overkill for 2 symbols — instead we re-export the parser by
// reading + replacing its import line. See tests/parser.test.mjs.
export const SillyTavern = {
    libs: { localforage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } },
    getContext: () => ({
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
        powerUserSettings: { persona_descriptions: {} },
        chat: [],
    }),
};