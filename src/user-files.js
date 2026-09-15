// @ts-check
/**
 * Glosses — SillyTavern user-files API helpers
 *
 * Ported from DS Comments (src/user-files.js). Thin wrappers over the official
 * per-user file surface (the same routes ST itself uses for chat attachments):
 * files live in `data/<user>/user/files/` on the SERVER, so they travel with
 * the SillyTavern data directory and are shared by every browser/device logged
 * into the same user profile.
 *   POST /api/files/upload  { name, data: base64 }        → atomic write
 *   GET  /user/files/<name>                               → static read (correct MIME)
 *   POST /api/files/delete  { path: 'user/files/<name>' }
 *   POST /api/files/verify  { urls: [...] }               → { url: exists }
 *
 * Server-side name constraints (validateAssetFileName in ST): ASCII letters,
 * digits, '_', '-', '.' only — callers must derive names from ids, never from
 * user-typed display names.
 */

import { getCtx } from './core.js';

function stHeaders() {
    const h = getCtx()?.getRequestHeaders?.();
    return h && typeof h === 'object' ? h : { 'Content-Type': 'application/json' };
}

/** Client URL for a stored user file (same-origin static route). */
export function userFileUrl(name) {
    return `/user/files/${encodeURIComponent(name)}`;
}

/** Upload (or atomically overwrite) a file. `data` is raw base64, no data-URL prefix. */
export async function uploadUserFile(name, base64Data) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: stHeaders(),
        body: JSON.stringify({ name, data: base64Data }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
    return name;
}

/** Delete a stored file; a missing file (404) is not an error. */
export async function deleteUserFile(name) {
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: stHeaders(),
        body: JSON.stringify({ path: `user/files/${name}` }),
    });
    if (!res.ok && res.status !== 404) {
        throw new Error(`delete failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
}

/**
 * Check which files exist. Returns { name: boolean }; names the server did not
 * report are omitted, and any transport/server failure yields {} — callers
 * must treat an empty result as "unknown", never as "missing".
 */
export async function verifyUserFiles(names) {
    if (!names?.length) return {};
    try {
        const res = await fetch('/api/files/verify', {
            method: 'POST',
            headers: stHeaders(),
            body: JSON.stringify({ urls: names.map(n => `user/files/${n}`) }),
        });
        if (!res.ok) return {};
        const verified = await res.json();
        if (!verified || typeof verified !== 'object') return {};
        const out = {};
        for (const n of names) {
            const reported = verified[`user/files/${n}`];
            if (reported === true || reported === false) out[n] = reported;
        }
        return out;
    } catch {
        return {};
    }
}
