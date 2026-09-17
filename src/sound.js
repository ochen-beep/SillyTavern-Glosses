// @ts-check
/**
 * Glosses — Sound notification module
 *
 * Sound sources (settings.soundId):
 *   'folder:<file>' — bundled sounds shipped in sounds/ (HTTP)
 *   'custom_<n>'    — user uploads. The audio file lives SERVER-side in the
 *                     per-user file store (data/<user>/user/files/, see
 *                     user-files.js) under 'gls_sound_custom_<n>.<ext>';
 *                     settings.json keeps only metadata in soundFiles
 *                     { custom_<n>: { name, file } }. Playback uses the
 *                     static /user/files/<name> URL, so custom sounds travel
 *                     with the SillyTavern data directory and work in any
 *                     browser/device on the same user profile.
 *
 * Legacy (pre-3.6): settings.soundName held a bundled filename or
 * '__custom__' (a data-URL blob in browser localforage — device-bound).
 * migrateLegacySound() lifts surviving blobs into the server store once, and
 * maps legacy bundled names onto the folder: scheme. The localforage blob is
 * removed only after a successful upload; on failure the user is told (the
 * blob stays as a backup) and the default sound is selected.
 */

import { S, getExtBase, LF_CUSTOM_SOUND, DEFAULT_SOUND_NAME, saveSettings, notifyUser, t, warn } from './core.js';
import { userFileUrl, uploadUserFile, deleteUserFile, verifyUserFiles } from './user-files.js';

export { DEFAULT_SOUND_NAME };

// Bundled sounds shipped in sounds/ folder (soundId prefix 'folder:').
// This list MUST mirror the sounds/ directory — test/sounds-on-disk.test.mjs enforces it.
export const BUNDLED_SOUNDS = [
    { file: DEFAULT_SOUND_NAME, label: 'Tiny Minimalist Bubble' },
    { file: 'Minimalist_mobile_ap_#4-1780921123489.wav', label: 'Minimalist Mobile' },
    { file: 'Soft_8-bit_pixel_int_#1-1780921844965.wav', label: 'Soft 8-bit Pixel' },
    { file: 'Subtle_digital_synth_#1-1780921738633.wav', label: 'Subtle Digital Synth' },
    { file: 'Tiny_crystalline_gla_#2-1780921518367.wav', label: 'Tiny Crystalline' },
    { file: 'music-reminder-sound.ogg', label: 'Music Reminder' },
];

export const LEGACY_CUSTOM_SOUND = '__custom__';
const CUSTOM_KEY_RE = /^custom_(\d+)$/;
const MIME_TO_EXT = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
    'audio/ogg': 'ogg', 'audio/vorbis': 'ogg', 'application/ogg': 'ogg',
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a',
    'audio/webm': 'webm',
};

/**
 * Normalize a stored sound reference to the soundId scheme. Pure.
 *   'folder:<bundled file>'     → kept when the file is in BUNDLED_SOUNDS
 *   'custom_<n>'                → kept (metadata existence checked at resolve time)
 *   plain bundled filename      → legacy settings.soundName → 'folder:<file>'
 *   '__custom__'                → legacy marker, returned as-is (migration input)
 *   anything else / empty       → '' (caller decides the default)
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSoundId(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (s === LEGACY_CUSTOM_SOUND) return s;
    if (CUSTOM_KEY_RE.test(s)) return s;
    if (s.startsWith('folder:')) {
        const file = s.slice('folder:'.length);
        return BUNDLED_SOUNDS.some(b => b.file === file) ? s : '';
    }
    // Legacy plain bundled filename (pre-3.6 settings.soundName).
    if (BUNDLED_SOUNDS.some(b => b.file === s)) return `folder:${s}`;
    return '';
}

/** The effective soundId, normalized; empty → the bundled default. */
export function resolveSoundId() {
    return normalizeSoundId(S().soundId) || `folder:${DEFAULT_SOUND_NAME}`;
}

/** True for the server-side custom_<n> ids. */
export function isCustomSoundId(id) {
    return CUSTOM_KEY_RE.test(String(id || ''));
}

/** Monotonic custom_<n> key seeded from the highest existing one. */
export function nextCustomKey(files) {
    let max = 0;
    for (const key of Object.keys(files || {})) {
        const m = CUSTOM_KEY_RE.exec(key);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `custom_${max + 1}`;
}

/** Server-side file name for a custom sound key — ASCII-only by ST constraint. */
export function glsSoundFileName(key, ext) {
    const safeExt = /^[a-z0-9]{1,5}$/i.test(String(ext || '')) ? String(ext) : 'wav';
    return `gls_sound_${key}.${safeExt}`;
}

/** data URL → { base64, ext } (base64 stripped of the `data:...;base64,` prefix). */
export function parseDataUrl(dataUrl) {
    const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1] || '';
    return { base64: m[2], ext: MIME_TO_EXT[mime.toLowerCase()] || '' };
}

/** Normalize the soundFiles metadata map: custom_<n> → { name, file } strings only. */
export function normalizeSoundFiles(value) {
    const source = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const [key, meta] of Object.entries(source)) {
        if (!CUSTOM_KEY_RE.test(key)) continue;
        const file = meta && typeof meta === 'object' ? String(meta.file || '') : '';
        if (!file) continue;
        const name = meta && typeof meta === 'object' && meta.name ? String(meta.name) : key;
        out[key] = { name, file };
    }
    return out;
}

/**
 * One-time migration from the pre-3.6 scheme (settings.soundName + a
 * localforage blob) to soundId + server-side files. Idempotent: a no-op when
 * soundId is already valid. Returns true when something was written.
 */
export async function migrateLegacySound() {
    if (normalizeSoundId(S().soundId)) return false;
    const legacy = String(S().soundName ?? '');
    const mapped = normalizeSoundId(legacy);
    if (mapped && mapped !== LEGACY_CUSTOM_SOUND) {
        S().soundId = mapped;
        saveSettings();
        return true;
    }
    if (legacy !== LEGACY_CUSTOM_SOUND) {
        S().soundId = `folder:${DEFAULT_SOUND_NAME}`;
        saveSettings();
        return true;
    }
    // Legacy custom blob → server store.
    try {
        const { localforage } = SillyTavern.libs;
        const dataUrl = await localforage.getItem(LF_CUSTOM_SOUND);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed || !parsed.base64) throw new Error('legacy blob missing or unreadable');
        const key = nextCustomKey(S().soundFiles);
        const file = glsSoundFileName(key, parsed.ext || 'wav');
        await uploadUserFile(file, parsed.base64);
        S().soundFiles = normalizeSoundFiles({ ...S().soundFiles, [key]: { name: t('Custom sound'), file } });
        S().soundId = key;
        await localforage.removeItem(LF_CUSTOM_SOUND);
        saveSettings();
        return true;
    } catch (e) {
        // The blob stays in place as a backup; select the default and tell the
        // user once — silently losing their sound would look like a regression.
        warn('Glosses: custom sound migration failed:', e);
        S().soundId = `folder:${DEFAULT_SOUND_NAME}`;
        saveSettings();
        try { notifyUser('warning', t('Could not migrate the custom sound to the server storage; the default sound is selected. The old copy stays in this browser.'), 'gls-sound-migrate'); } catch { /* non-fatal */ }
        return false;
    }
}

/** Verify server-side customs; returns the metadata keys whose file is gone. */
export async function missingCustomSoundKeys() {
    const files = normalizeSoundFiles(S().soundFiles);
    const keys = Object.keys(files);
    if (!keys.length) return [];
    const verified = await verifyUserFiles(keys.map(k => files[k].file));
    // {} means "unknown" (transport failure) — never report missing on that.
    if (!Object.keys(verified).length) return [];
    return keys.filter(k => verified[files[k].file] === false);
}

/** Delete a server-side custom sound (file + metadata); deselects it if active. */
export async function deleteCustomSound(key) {
    const meta = normalizeSoundFiles(S().soundFiles)[key];
    if (!meta) return false;
    try { await deleteUserFile(meta.file); } catch (e) { warn('Glosses: custom sound delete failed:', e); }
    const files = { ...S().soundFiles };
    delete files[key];
    S().soundFiles = files;
    if (resolveSoundId() === key) S().soundId = `folder:${DEFAULT_SOUND_NAME}`;
    saveSettings();
    return true;
}

async function resolveSoundUri() {
    const id = resolveSoundId();
    if (CUSTOM_KEY_RE.test(id)) {
        const meta = normalizeSoundFiles(S().soundFiles)[id];
        if (!meta?.file) return null; // metadata gone — caller falls back
        return userFileUrl(meta.file);
    }
    const fileName = id.startsWith('folder:') ? id.slice('folder:'.length) : DEFAULT_SOUND_NAME;
    // encodeURIComponent required: bundled filenames contain '#', which without
    // encoding becomes a URL fragment → the server never sees it → 404.
    return `${getExtBase()}/sounds/${encodeURIComponent(fileName)}`;
}

export async function playSound() {
    if (!S().soundEnabled) return;
    try {
        const uri = await resolveSoundUri();
        if (!uri) throw new Error('custom sound metadata missing');
        const audio = new Audio(uri);
        audio.volume = (S().soundVolume ?? 30) / 100;
        await audio.play();
    } catch {
        // A gone server file (or metadata) must not silence notifications:
        // fall back to the bundled default. Autoplay-blocked play() rejections
        // land here too — the retry is harmless (browsers allow it after a
        // user gesture, which every generation is).
        try {
            if (!resolveSoundId().startsWith('folder:')) {
                notifyUser('warning', t('The selected custom sound is unavailable; playing the default sound.'), 'gls-sound-missing');
            }
            const audio = new Audio(`${getExtBase()}/sounds/${encodeURIComponent(DEFAULT_SOUND_NAME)}`);
            audio.volume = (S().soundVolume ?? 30) / 100;
            await audio.play();
        } catch { /* autoplay blocked */ }
    }
}

/** Drop the cached URI so a newly selected sound takes effect on next play. */
export function invalidateSoundCache() {
    // resolveSoundUri() builds the URI fresh on every play (no URI cache is
    // kept — the old _cachedSoundUri variable was never read). The hook stays
    // so existing callers keep working and a future cache has a clear hook.
}

/** Populate the sound <select>: bundled + server-side custom uploads. */
export function populateSoundSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const s of BUNDLED_SOUNDS) {
        const opt = document.createElement('option');
        opt.value = `folder:${s.file}`;
        opt.textContent = t(s.label);
        selectEl.appendChild(opt);
    }
    for (const [key, meta] of Object.entries(normalizeSoundFiles(S().soundFiles))) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `🎵 ${meta.name}`;
        selectEl.appendChild(opt);
    }
    const id = resolveSoundId();
    selectEl.value = [...selectEl.options].some(o => o.value === id)
        ? id
        : `folder:${DEFAULT_SOUND_NAME}`;
}

/**
 * Init pass (index.js, after loadSettings): run the legacy migration, verify
 * server-side files, warn once about a missing selected sound, and refresh
 * the settings dropdown when the migration changed the state. Idempotent.
 */
export async function initSound() {
    try {
        const changed = await migrateLegacySound();
        const missing = await missingCustomSoundKeys();
        const selected = resolveSoundId();
        if (missing.includes(selected)) {
            notifyUser('warning', t('The selected custom sound is missing on the server; the default sound plays instead. Re-upload it in the Glosses settings.'), 'gls-sound-missing');
        }
        if (changed || missing.length) {
            populateSoundSelect(document.getElementById('gls_sound_select'));
        }
    } catch (e) {
        warn('Glosses: sound init failed:', e);
    }
}
