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

import { getCtx, MIN_POST_LENGTH } from '../core.js';

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
 * Read the plain text of a message at a given swipe, mirroring ST's variant
 * selection rule (swipes[idx] when present, else mes). Returns '' when absent.
 *
 *   - variant text is never truncated, so prefix-sharing messages remain distinct.
 *
 * @param {number|string} msgId
 * @param {number} [swipeIdx]
 * @returns {string}
 */
export function messageText(msgId, swipeIdx = 0) {
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(msgId)];
    if (!msg) return '';
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    const candidate = swipes && swipes[parseInt(swipeIdx)] !== undefined
        ? swipes[parseInt(swipeIdx)]
        : msg.mes;
    return String(candidate ?? '');
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
 * Build a full message identity object for a (msgId, swipeIdx).
 *
 * Returns null when the message is absent or its body is not viable (placeholder
 * / too short) — callers should treat null as "no identity, skip".
 *
 * @param {number|string} msgId
 * @param {number} [swipeIdx]
 * @returns {{ msgId: string, swipeIdx: number, contentDigest: string, text: string } | null}
 */
export function buildIdentity(msgId, swipeIdx = 0) {
    const text = messageText(msgId, swipeIdx);
    if (!isViableMessageText(text)) return null;
    return {
        msgId: String(msgId),
        swipeIdx: Number(swipeIdx),
        contentDigest: contentDigest(text),
        text,
    };
}

