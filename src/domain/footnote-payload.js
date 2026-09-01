// @ts-check
/**
 * Glosses — Footnote payload (per-swipe-variant storage, schema 1)
 *
 * The footnote set for one swipe variant lives INSIDE the message object the
 * variant belongs to, on the host-managed per-swipe slots:
 *
 *   swipe_info[swipe_id].extra.gls   — the variant-addressed copy (canonical)
 *   msg.extra.gls                    — live mirror for the shown variant
 *
 * SillyTavern itself maintains the variant↔extra association (syncMesToSwipe /
 * syncSwipeToMes swap `extra` wholesale on every variant switch and snapshot
 * it on swipe-away), so the "which text is showing" binding is owned by the
 * host, not re-derived by the extension.
 *
 * CORRECTNESS INVARIANT: a payload is only ever *used* when its
 * `contentDigest` equals the digest of the variant's current text. Any
 * out-of-sync state — an inherited extra clone on a freshly created swipe slot,
 * a text edit, a restored old chat — fails the gate and reads as "no
 * footnotes", never as wrong footnotes. The raw (ungated) read exists solely
 * for the rebind path, which needs the stale payload to repair it.
 *
 * The digest is computed over the RAW NFC-normalized variant text
 * (`swipes[idx] ?? mes`) — the same source ST syncs on edit — so it is
 * DOM-independent and deterministic in Node tests.
 *
 * Messages without swipe machinery (user posts, exotic hosts) have no
 * swipe_info; for them the live `msg.extra.gls` copy is the only storage.
 */

import { contentDigest, isViableMessageText } from './message-identity.js';

/** Key inside swipe_info[i].extra / msg.extra where the payload lives. */
export const PAYLOAD_KEY = 'gls';
/** Payload schema version. Bump + handle on read when the shape changes. */
export const PAYLOAD_SCHEMA = 1;

/**
 * The text of a message variant — mirrors ST's own selection rule
 * (swipes[idx] when present, else mes). Returns '' for a missing message.
 *
 * @param {object|null|undefined} msg
 * @param {number|string} [swipeIdx]
 * @returns {string}
 */
export function variantText(msg, swipeIdx = 0) {
    if (!msg) return '';
    const idx = Number(swipeIdx) || 0;
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    const candidate = swipes && swipes[idx] !== undefined ? swipes[idx] : msg.mes;
    return String(candidate ?? '');
}

/**
 * Digest of a variant's current text ('' for empty text). This is the identity
 * the payload self-verifies against.
 *
 * @param {object|null|undefined} msg
 * @param {number|string} [swipeIdx]
 * @returns {string}
 */
export function digestForVariant(msg, swipeIdx = 0) {
    return contentDigest(variantText(msg, swipeIdx));
}

function isPayloadShape(value) {
    return !!value && typeof value === 'object'
        && Number(value.schema) === PAYLOAD_SCHEMA
        && typeof value.contentDigest === 'string' && value.contentDigest.length > 0
        && Array.isArray(value.footnotes);
}

/**
 * Read a variant's payload WITHOUT the digest gate. For the rebind/inspect
 * paths that must find a stale payload to repair it. Display paths must use
 * readVerifiedPayload instead.
 *
 * @param {object|null|undefined} msg
 * @param {number|string} [swipeIdx]
 * @returns {object|null}
 */
export function readRawPayload(msg, swipeIdx = 0) {
    if (!msg) return null;
    const idx = Number(swipeIdx) || 0;
    const hasSlots = Array.isArray(msg.swipe_info);
    // The live-mirror fallback exists ONLY for messages without swipe
    // machinery (user posts, exotic hosts), where msg.extra is the sole
    // storage. For slotted messages the mirror reflects the SHOWN variant
    // (syncSwipeToMes wholesale-replaces it), so falling back to it can serve
    // a payload that belongs to whatever variant was on screen — a second
    // leak path for foreign payloads, closed here.
    const candidate = hasSlots
        ? msg.swipe_info[idx]?.extra?.[PAYLOAD_KEY] ?? null
        : msg.extra?.[PAYLOAD_KEY] ?? null;
    return isPayloadShape(candidate) ? candidate : null;
}

/**
 * True when the payload's digest equals the CURRENT text of a DIFFERENT
 * variant of the same message — i.e. the payload was generated for that other
 * variant and reached this slot through SillyTavern's own extra cloning
 * (syncMesToSwipe snapshots the live extra into a new swipe slot when a swipe
 * is created at generation end), not through this variant's text being
 * edited. Such a payload is FOREIGN: re-binding it would transplant the other
 * variant's footnotes onto whatever words happen to match, so it must be
 * cleared instead of repaired.
 *
 * @param {object|null|undefined} msg
 * @param {number|string} [swipeIdx]
 * @param {object|null|undefined} payload
 * @returns {boolean}
 */
export function payloadBelongsToOtherVariant(msg, swipeIdx, payload) {
    if (!msg || !isPayloadShape(payload)) return false;
    const idx = Number(swipeIdx) || 0;
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    if (!swipes) return false;
    for (let i = 0; i < swipes.length; i++) {
        if (i === idx) continue;
        if (contentDigest(String(swipes[i] ?? '')) === payload.contentDigest) return true;
    }
    return false;
}

/**
 * Digest-verified payload — the ONLY read the display/generation paths may
 * trust. Returns null when there is no payload, the variant text is not
 * viable (placeholder/too short), or the digest no longer matches the text.
 *
 * @param {object|null|undefined} msg
 * @param {number|string} [swipeIdx]
 * @returns {object|null}
 */
export function readVerifiedPayload(msg, swipeIdx = 0) {
    const raw = readRawPayload(msg, swipeIdx);
    if (!raw) return null;
    if (!isViableMessageText(variantText(msg, swipeIdx))) return null;
    if (raw.contentDigest !== digestForVariant(msg, swipeIdx)) return null;
    return raw;
}

/**
 * Ensure swipe_info[idx] exists with an extra object; returns the slot or null
 * when the message has no swipe machinery (live-extra-only storage).
 */
function ensureSlot(msg, swipeIdx) {
    if (!Array.isArray(msg.swipe_info)) return null;
    const idx = Number(swipeIdx) || 0;
    if (!msg.swipe_info[idx] || typeof msg.swipe_info[idx] !== 'object') msg.swipe_info[idx] = {};
    const slot = msg.swipe_info[idx];
    if (!slot.extra || typeof slot.extra !== 'object') slot.extra = {};
    return slot;
}

/**
 * Build a payload stamped with the digest of the variant's CURRENT text.
 * Returns null when the text is not viable — never persist a payload keyed to
 * a placeholder ('...') or an empty streaming slot.
 *
 * `meta.targeted` carries the targeted-footnote array («Точечно» tab). It is
 * the caller's (cache layer's) responsibility to pass the array that should
 * SURVIVE this write — a regular regeneration must re-read and forward the
 * existing targeted entries so it can never wipe them (anti-race contract).
 *
 * @param {object} msg
 * @param {number|string} swipeIdx
 * @param {Array} footnotes
 * @param {{ style?: string, orphans?: Array, targeted?: Array }} [meta]
 */
export function stampPayload(msg, swipeIdx, footnotes, meta = {}) {
    const text = variantText(msg, swipeIdx);
    if (!isViableMessageText(text)) return null;
    return {
        schema: PAYLOAD_SCHEMA,
        contentDigest: contentDigest(text),
        generatedAt: Date.now(),
        style: typeof meta.style === 'string' ? meta.style : '',
        footnotes: Array.isArray(footnotes) ? footnotes : [],
        targeted: Array.isArray(meta.targeted) ? meta.targeted : [],
        orphans: Array.isArray(meta.orphans) ? meta.orphans : [],
    };
}

/**
 * Targeted entries of a payload, normalized to an array. Payloads written
 * before targeted footnotes existed (schema 1, no `targeted` field) read as
 * empty — no migration needed.
 *
 * @param {object|null|undefined} payload
 * @returns {Array}
 */
export function targetedOf(payload) {
    return Array.isArray(payload?.targeted) ? payload.targeted : [];
}

/**
 * Persist a payload for a variant. Race-safe write rule:
 *   - the swipe_info slot is written ALWAYS (it is variant-addressed, so a
 *     concurrent variant switch cannot misfile it);
 *   - the live msg.extra mirror is written only while the message still shows
 *     this variant — an async generation that lands after the user swiped
 *     away must not contaminate the newly shown variant.
 *
 * The payload's own digest must already match the variant text (callers use
 * stampPayload, or preserve a rebind-verified payload); this function does not
 * re-stamp, it only files the payload.
 *
 * @param {object} msg
 * @param {number|string} swipeIdx
 * @param {object} payload
 * @returns {object|null} the filed payload, or null on invalid input.
 */
export function writePayload(msg, swipeIdx, payload) {
    if (!msg || !isPayloadShape(payload)) return null;
    const idx = Number(swipeIdx) || 0;
    const slot = ensureSlot(msg, idx);
    if (slot) slot.extra[PAYLOAD_KEY] = payload;
    if ((msg.swipe_id ?? 0) === idx) {
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra[PAYLOAD_KEY] = payload;
    }
    return payload;
}

/**
 * Remove the payload from a variant's slot (and the live mirror when it
 * reflects that variant). Returns true when anything was removed.
 *
 * @param {object} msg
 * @param {number|string} [swipeIdx]
 * @returns {boolean}
 */
export function clearPayload(msg, swipeIdx = 0) {
    if (!msg) return false;
    const idx = Number(swipeIdx) || 0;
    let removed = false;
    const slot = Array.isArray(msg.swipe_info) ? msg.swipe_info[idx] : null;
    if (slot?.extra && PAYLOAD_KEY in slot.extra) {
        delete slot.extra[PAYLOAD_KEY];
        removed = true;
    }
    if ((msg.swipe_id ?? 0) === idx && msg.extra && PAYLOAD_KEY in msg.extra) {
        delete msg.extra[PAYLOAD_KEY];
        removed = true;
    }
    return removed;
}
