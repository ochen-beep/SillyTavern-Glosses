// @ts-check
/**
 * Glosses — Clipboard helper with an execCommand fallback.
 *
 * navigator.clipboard exists only in secure contexts (https / localhost). The
 * common mobile SillyTavern setup — a phone browser against
 * http://192.168.x.x:8000 — has NO clipboard API, so every copy path must
 * degrade to the legacy document.execCommand('copy') trick instead of
 * reporting a false success: the old `await navigator.clipboard?.writeText()`
 * resolved to undefined on insecure origins, showed "Copied ✓", and copied
 * nothing.
 *
 * copyText() is dependency-injectable (clipboard / fallback) so unit tests can
 * cover all four paths without a real document.
 */

/**
 * Legacy copy via a transient selected textarea + document.execCommand('copy').
 * Works on insecure origins, but only inside a user-gesture task.
 *
 * @param {string} text
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function copyViaFallback(text, doc = document) {
    try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        const ok = doc.execCommand('copy');
        ta.remove();
        return ok;
    } catch { return false; }
}

/**
 * Copy text through the async Clipboard API when available, falling back to
 * the execCommand path when it is missing (insecure origin) or rejects
 * (permission denied). Resolves true only when something was actually
 * written — callers must gate their "Copied" feedback on the result.
 *
 * @param {string} text
 * @param {{ clipboard?: { writeText: (text: string) => Promise<void> } | null, fallback?: (text: string) => boolean }} [deps]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
    const clipboard = deps.clipboard !== undefined ? deps.clipboard : globalThis.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
        try {
            await clipboard.writeText(text);
            return true;
        } catch { /* rejected → try the legacy path before giving up */ }
    }
    const fallback = deps.fallback || copyViaFallback;
    try { return !!fallback(text); } catch { return false; }
}
