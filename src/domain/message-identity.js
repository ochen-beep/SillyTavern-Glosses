// @ts-check
/**
 * Glosses — Message identity helpers
 *
 * SillyTavern's message index is NOT a durable id: deleting a middle message
 * shifts every subsequent index, and DOM `.mes[mesid]` mirrors that index. A
 * stable identity therefore can't be built on the index alone.
 *
 * Since v3.2 the footnote payload store is content-anchored: each swipe
 * variant's payload carries `contentDigest` — a digest of the FULL
 * NFC-normalized variant text — and self-verifies against it on every read
 * (see domain/footnote-payload.js). The index + swipeIdx remain live-lookup
 * coordinates only, never identity.
 *
 * Stability note: contentDigest is content-addressed, so if a message is
 * edited back to a previously-seen body, the payload stored for that body
 * becomes valid again — the desired behaviour (the footnotes still apply).
 */

import { MIN_POST_LENGTH, S } from '../core.js';

/**
 * Compute a stable, non-cryptographic digest of the full NFC-normalized text.
 *
 * djb2 is sufficient here: the digest is an index key, not a security
 * primitive. Returning a short hex string keeps metadata compact. Collisions
 * on djb2 over realistic message counts (<1e6 per chat) are negligible and, if
 * one ever occurred, the digest gate would simply mismatch on the next text
 * change — no corruption.
 *
 * @param {string} text
 * @returns {string} 8-char hex digest, or '' for empty input
 */
export function contentDigest(text) {
    const s = String(text ?? '').normalize('NFC');
    if (!s) return '';
    // djb2: hash = 5381; hash = hash * 33 ^ char.
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * True when a message body is too short or a placeholder to be a valid identity.
 * Mirrors the false-start guard so identity is never computed for a half-written
 * post (which would otherwise hash the `'...'` placeholder and poison lookups).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isViableMessageText(text) {
    const check = (text || '').trim();
    return !!check && check !== '...' && check.length >= MIN_POST_LENGTH;
}

/**
 * True when the message DOM is currently showing a TRANSLATION rather than the
 * digest-source body. The built-in Translate extension keeps the alternate text
 * in `extra.display_text` and renders it when present (incoming/AI:
 * display_text = translation, mes = original; outgoing/user: display_text =
 * original, mes = translation — translate/index.js:215/533);
 * `extra.reasoning_display_text` covers reasoning-only translations. While
 * either is present the payload digest (computed over the variant body) no
 * longer describes what is on screen, so marker injection / rebind /
 * auto-generation / manual regeneration must skip the message.
 *
 * @param {{ extra?: { display_text?: unknown, reasoning_display_text?: unknown } | null } | null | undefined} msg
 * @returns {boolean}
 */
export function isTranslatedView(msg) {
    return Boolean(msg?.extra?.display_text || msg?.extra?.reasoning_display_text);
}

/**
 * Can this message carry footnotes at all? AI messages always; the user's own
 * posts only when glossUserMessages is on; system messages never. The single
 * predicate behind the targeted tab's focus check, the panel's empty-state
 * decision, and /glosses_regen target picking. (The marker-rendering guards
 * in renderer.js are a DIFFERENT, weaker predicate — user gate + translation
 * gate, no is_system exclusion — and deliberately stay inline there.)
 * @param {{ is_system?: unknown, is_user?: unknown } | null | undefined} msg
 * @returns {boolean}
 */
export function isAnnotatableMsg(msg) {
    if (!msg) return false;
    if (msg.is_system) return false;
    return msg.is_user ? Boolean(S().glossUserMessages) : true;
}

