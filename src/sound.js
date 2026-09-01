// @ts-check
/**
 * Glosses — Sound notification module
 * Ported 1:1 from SillyTavern-Footnotes. Plays a (bundled or user-uploaded)
 * sound after a successful footnote generation.
 */

import { S, getExtBase, LF_CUSTOM_SOUND, DEFAULT_SOUND_NAME } from './core.js';

export const BUNDLED_SOUNDS = [
    { file: DEFAULT_SOUND_NAME, label: 'Tiny Minimalist Bubble' },
    { file: 'Minimalist_mobile_ap_#4-1780921123489.wav', label: 'Minimalist Mobile' },
    { file: 'Soft_8-bit_pixel_int_#1-1780921844965.wav', label: 'Soft 8-bit Pixel' },
    { file: 'Subtle_digital_synth_#1-1780921738633.wav', label: 'Subtle Digital Synth' },
    { file: 'Tiny_crystalline_gla_#2-1780921518367.wav', label: 'Tiny Crystalline' },
];

let _cachedSoundUri = null;

async function resolveSoundUri() {
    if (_cachedSoundUri) return _cachedSoundUri;
    if (S().soundName === '__custom__') {
        try {
            const { localforage } = SillyTavern.libs;
            _cachedSoundUri = await localforage.getItem(LF_CUSTOM_SOUND);
        } catch { /* ok */ }
        return _cachedSoundUri;
    }
    const fileName = S().soundName || BUNDLED_SOUNDS[0].file;
    // encodeURIComponent required: bundled filenames contain '#', which without
    // encoding becomes a URL fragment → the server never sees it → 404.
    _cachedSoundUri = `${getExtBase()}/sounds/${encodeURIComponent(fileName)}`;
    return _cachedSoundUri;
}

export async function playSound() {
    if (!S().soundEnabled) return;
    try {
        const uri = await resolveSoundUri();
        if (!uri) return;
        const audio = new Audio(uri);
        audio.volume = (S().soundVolume ?? 30) / 100;
        await audio.play();
    } catch { /* autoplay blocked */ }
}

/** Drop the cached URI so a newly selected sound takes effect on next play. */
export function invalidateSoundCache() {
    _cachedSoundUri = null;
}

/** Populate the sound <select> with bundled + optional custom entry. */
export function populateSoundSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const s of BUNDLED_SOUNDS) {
        const opt = document.createElement('option');
        opt.value = s.file;
        opt.textContent = s.label;
        selectEl.appendChild(opt);
    }
    if (S().soundName === '__custom__') {
        const opt = document.createElement('option');
        opt.value = '__custom__';
        opt.textContent = '🎵 Custom sound';
        selectEl.appendChild(opt);
    }
    selectEl.value = S().soundName || BUNDLED_SOUNDS[0].file;
}

