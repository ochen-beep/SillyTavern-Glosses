// @ts-check
/**
 * Glosses — Events module
 * ST event handling and scroll observer for "follow the visible message".
 *
 * Ported 1:1 from SillyTavern-Footnotes (the Footnotes Database popup was
 * removed in v3.0 — search/export/clear-all now live in the floating panel
 * and the /glosses clear slash command).
 */

import {
    state, S, getCtx, t, warn, MIN_POST_LENGTH,
} from './core.js';
import { generationCoordinator } from './application/generation-coordinator.js';
import {
    getVariantPayload, getVariantFootnotes, readRawPayloadFor, rebindVariant,
} from './cache.js';
import { isTranslatedView } from './domain/message-identity.js';
import {
    PAYLOAD_KEY, readRawPayload, writePayload, clearPayload, digestForVariant,
} from './domain/footnote-payload.js';
import {
    injectHighlights, removeHighlights, restoreHighlightsAll, restoreMessage, addRegenButton,
    installMarkerDelegation, resetLazyInjector, closePopup,
} from './renderer.js';
import {
    updatePanel, setVisiblePost, invalidateAiMsgCache, panelInvalidate, clearTargetedTabState,
} from './ui/window.js';
import { ensureLauncher } from './ui/launcher.js';
import { generateFootnotes } from './generator.js';
import { checkSourceConfigured } from './connection.js';

// ══════════════════════════════════════════════════════════════════════════════
// EVENT BINDING
// ══════════════════════════════════════════════════════════════════════════════

const _eventHandlers = {};
let _eventsBound = false;

// Fire-and-forget with a log line. ST AWAITS every event subscriber
// (eventemitter.js) — CHARACTER_MESSAGE_RENDERED mid-Generate, MESSAGE_SWIPED
// before the next swipe — and these handlers can run a full LLM request (up
// to the endpoint timeout). Returning that promise would stall the host's
// pipeline; race safety lives in the generation coordinator's guards.
const bg = (p, msg) => p.catch(e => warn(msg, e));
// Feature-detect MESSAGE_UPDATED (emitted AFTER ST re-renders an edited
// message — script.js messageEditDone). Min client has it; the fallback for
// hosts without it rebinds on MESSAGE_EDITED with a deferred DOM injection.
let _hasUpdatedEvent = false;

export function bindEvents() {
    if (_eventsBound) return;
    const { eventSource, event_types } = getCtx();
    // Bail out without setting the flag if the host contract isn't ready — a
    // later init pass must still be able to bind.
    if (!eventSource || !event_types) return;

    const on = (ev, fn) => {
        eventSource.on(ev, fn);
        _eventHandlers[ev] = _eventHandlers[ev] || [];
        _eventHandlers[ev].push(fn);
    };

    on(event_types.APP_INITIALIZED, onAppReady);
    on(event_types.CHAT_CHANGED, onChatChanged);
    on(event_types.CHARACTER_MESSAGE_RENDERED, onCharMsgRendered);
    on(event_types.MESSAGE_SWIPED, onMsgSwiped);
    on(event_types.MESSAGE_EDITED, onMsgEdited);
    on(event_types.MESSAGE_DELETED, onMsgDeleted);
    _hasUpdatedEvent = !!event_types.MESSAGE_UPDATED;
    if (_hasUpdatedEvent) on(event_types.MESSAGE_UPDATED, onMsgUpdated);
    // Lazy-load: ST's "Show more messages" prepends older messages that were
    // not in the DOM at chat-open → restoreHighlightsAll missed them. Re-run
    // the per-message restore so markers + regen buttons appear.
    if (event_types.MORE_MESSAGES_LOADED) {
        on(event_types.MORE_MESSAGES_LOADED, onMoreMessagesLoaded);
    }
    // Swipe deletion (feature-detected, ported from DS Comments): abort the
    // in-flight generation of the deleted slot and re-present the surviving
    // current variant.
    if (event_types.MESSAGE_SWIPE_DELETED) {
        on(event_types.MESSAGE_SWIPE_DELETED, onMsgSwipeDeleted);
    }

    // WORLD_INFO_ACTIVATED: stash the entries ST's main prompt build just
    // activated, for per-chat automatic lore (lorebooks.js). The event fires
    // BEFORE the new message is pushed to chat, so binding to "the last post
    // at event time" would point at the PREVIOUS post — only a PENDING payload
    // is stashed here; onCharMsgRendered claims it and binds the actually
    // rendered message (see claimPendingActivatedWorldInfo).
    if (event_types.WORLD_INFO_ACTIVATED) {
        on(event_types.WORLD_INFO_ACTIVATED, async (entries) => {
            if (!Array.isArray(entries)) return;
            const ctx2 = getCtx();
            state.pendingActivatedWorldInfo = {
                chatId: ctx2.chatId,
                entries: entries.map(e => ({
                    uid: e.uid,
                    content: typeof e.content === 'string' ? e.content : '',
                    world: e.world,
                    comment: e.comment ?? e.name ?? '',
                    vectorized: Boolean(e.vectorized),
                })),
                ts: Date.now(),
            };
        });
    }

    _eventsBound = true;
}

export function unbindEvents() {
    const { eventSource } = getCtx();
    for (const [ev, handlers] of Object.entries(_eventHandlers)) {
        for (const fn of handlers) {
            try { eventSource?.removeListener?.(ev, fn); } catch { /* host may be gone */ }
        }
    }
    Object.keys(_eventHandlers).forEach(k => delete _eventHandlers[k]);
    _eventsBound = false;
    if (_editedRaf) { cancelAnimationFrame(_editedRaf); _editedRaf = 0; }
}

function onAppReady() {
    installMarkerDelegation();
    restoreHighlightsAll();
}

// Owned handle for the deferred post-chat-switch restore, so cleanup()
// (via disconnectScrollObserver) can cancel it — otherwise a disable inside
// the 0ms window lets the callback re-arm the scroll observer on a torn-down
// extension (same class of bug index.js fixes for its own _scrollInitTimer).
let _postChatSwitchTimer = null;
// Owned handle for the no-MESSAGE_UPDATED fallback double-rAF (onMsgEdited).
let _editedRaf = 0;

function onChatChanged() {
    // Stage 6: invalidate ALL in-flight generations — chat change bumps the
    // global chatEpoch (so still-running requests whose transports ignore
    // AbortSignal still discard via isCurrent) and aborts every controller.
    // This is the ONLY place that bumps the global epoch; swipes/edits of a
    // single message use bumpMessageRevision instead (scoped).
    generationCoordinator.invalidateAll();
    resetGenerationState();
    state.panelFocusMsgId = null;
    invalidateAiMsgCache();
    resetLazyInjector();
    installMarkerDelegation();
    if (_postChatSwitchTimer) clearTimeout(_postChatSwitchTimer);
    _postChatSwitchTimer = setTimeout(() => {
        _postChatSwitchTimer = null;
        restoreHighlightsAll();
        initScrollObserver();
    }, 0);
    // Clear the transient targeted request and state synchronously BEFORE the
    // panel re-render so an old chat-change continuation cannot cancel a new
    // chat's targeted request, and the first render of the new chat never
    // shows the previous chat's draft/result for a frame.
    clearTargetedTabState();
    _swipesLen.clear();
    updatePanel();
    // ST rebuilds #qr--bar on chat switch — re-mount the 📖 launcher so it
    // doesn't vanish from the quick-reply row.
    try { ensureLauncher(); } catch { /* non-critical */ }
}

function resetGenerationState() {
    for (const k of Object.keys(state.abortControllers)) delete state.abortControllers[k];
    for (const k of Object.keys(state.isGenerating)) delete state.isGenerating[k];
}

/**
 * Shared "the message is now showing variant swipeIdx" flow for rendered and
 * swiped messages: verified payload → inject; stale payload (text changed
 * while away — a "continue" or an edit of another slot) → rebind and inject
 * the survivors; nothing stored → auto-generate.
 */
async function presentVariant(messageId, swipeIdx, mesEl) {
    // Translation-detection guard: the built-in Translate extension writes
    // `message.mes` with translated text while preserving the original in
    // `extra.display_text` (translate/index.js:533). The digest mismatch is
    // intentional — rebind against the translated text would orphan every
    // footnote, and auto-generation would generate footnotes for the
    // translation rather than the original. Skip both; when the user
    // un-translates, the digest re-matches and the cached payload restores.
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (isTranslatedView(msg)) return;

    const payload = getVariantPayload(messageId, swipeIdx);
    if (payload) {
        // Merged read (regular + targeted) so both kinds' markers inject.
        const merged = getVariantFootnotes(messageId, swipeIdx);
        if (merged?.length) injectHighlights(mesEl, merged);
        // Zero-footnote payloads (everything orphaned by an earlier rebind)
        // fall through to the panel's orphan banner + regenerate CTA.
        updatePanel();
        return;
    }
    const raw = readRawPayloadFor(messageId, swipeIdx);
    if (raw) {
        // Stored for this variant but the digest no longer matches. rebindVariant
        // distinguishes two causes: the text changed under a native payload
        // (edit / continue — repair and inject the survivors), or the payload is
        // FOREIGN — its digest matches another variant of this message, meaning
        // SillyTavern's extra cloning planted the old swipe's payload in this
        // slot. A foreign payload is cleared inside rebindVariant; this variant
        // then behaves as if it never had footnotes and falls through to
        // auto-generation instead of showing transplanted anchors or a bogus
        // lost-anchors banner.
        const result = rebindVariant(messageId, swipeIdx);
        if (result?.foreign) {
            await autoGenerateIfConfigured(messageId, swipeIdx, mesEl);
            return;
        }
        const merged = getVariantFootnotes(messageId, swipeIdx);
        if (merged?.length) injectHighlights(mesEl, merged);
        updatePanel();
        return;
    }
    await autoGenerateIfConfigured(messageId, swipeIdx, mesEl);
}

function onCharMsgRendered(messageId) {
    const ctx = getCtx();
    const msg0 = ctx.chat?.[parseInt(messageId)];
    // Claim the pending WORLD_INFO_ACTIVATED payload BEFORE any skip-guard
    // (ported from DS Comments): it describes THIS message's prompt, so the
    // binding must land even when Glosses skips annotating the post. Always
    // consumed — one ST generation, exactly one claim.
    state.pendingActivatedWorldInfo = (() => {
        const pending = state.pendingActivatedWorldInfo;
        if (!pending) return null;
        if (pending.chatId !== ctx.chatId) return null;              // chat-switch race
        if (Date.now() - pending.ts > 120_000) return null;          // stale claim
        state.lastActivatedWorldInfo = {
            ...pending,
            msgId: String(messageId),
            swipeIdx: typeof msg0?.swipe_id === 'number' ? msg0.swipe_id : 0,
        };
        return null;
    })();
    const msg = msg0;
    // Track swipes.length on EVERY render (before the guards) — a swipe of a
    // message that never passed them must not look like an appending swipe.
    _swipesLen.set(Number(messageId), Array.isArray(msg?.swipes) ? msg.swipes.length : 0);
    if (!msg || msg.is_user || msg.is_system || msg.is_hidden || !S().enabled) return;

    // False-start guard (mirrors DS Comments src/events.js CHARACTER_MESSAGE_RENDERED
    // handler). SillyTavern leaves mes/swipe text as the `'...'` placeholder (or
    // empty) while a new post is still being generated. Without this guard the
    // placeholder would pass as a truthy identity, the payload read misses, and
    // generateFootnotes fires on a not-yet-written post — burning an API call.
    const swipeIdx = msg.swipe_id ?? 0;
    const candidate = Array.isArray(msg.swipes) ? (msg.swipes[swipeIdx] ?? msg.mes) : msg.mes;
    const postText = (candidate || '').trim();
    if (!postText || postText === '...' || postText.length < MIN_POST_LENGTH) return;

    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);

    addRegenButton(messageId);
    // A freshly rendered AI message invalidates the cached AI-id list.
    invalidateAiMsgCache();
    state.panelFocusMsgId = String(messageId);

    bg(presentVariant(messageId, swipeIdx, mesEl), 'presentVariant failed:');
}

// swipes.length per message id, captured at render and at every swipe event.
// The delta between two MESSAGE_SWIPED events is the only reliable "a slot
// was just APPENDED" signal — ST offers no pre-swipe event, and the payload
// relocation below must not run for plain navigation between existing slots.
const _swipesLen = new Map();

/**
 * Undo SillyTavern's swipe-slot cloning (F#6). Creating a swipe snapshots the
 * live `extra` — the PREVIOUS variant's payload — into the NEW slot and
 * rebuilds the previous slot without it. Left as-is, the old variant loses
 * its (possibly hand-edited) footnotes: swiping back regenerates instead of
 * restoring. On an appending swipe, move the clone back to the slot it was
 * generated for and clear it from the new one; the new variant then falls
 * through to fresh generation via the normal present path. Navigation
 * between existing variants never grows swipes.length and is skipped.
 */
function relocateClonedPayload(messageId) {
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg || !Array.isArray(msg.swipes) || !Array.isArray(msg.swipe_info)) return;
    const newIdx = msg.swipe_id ?? 0;
    const prevLen = _swipesLen.get(Number(messageId));
    _swipesLen.set(Number(messageId), msg.swipes.length);
    const isAppendingSwipe = typeof prevLen === 'number'
        && msg.swipes.length > prevLen
        && newIdx === msg.swipes.length - 1;
    if (!isAppendingSwipe) return;
    const prevIdx = newIdx - 1;
    if (prevIdx < 0) return;
    const prevSlot = msg.swipe_info[prevIdx];
    if (prevSlot?.extra && PAYLOAD_KEY in prevSlot.extra) return; // prev kept its payload — nothing was lost
    const cloned = readRawPayload(msg, newIdx);
    if (!cloned) return;
    // Only move a payload that verifiably belongs to the previous variant.
    if (cloned.contentDigest !== digestForVariant(msg, prevIdx)) return;
    writePayload(msg, prevIdx, cloned);
    clearPayload(msg, newIdx);
}

function onMsgSwiped(messageId) {
    // A swipe changes the text identity for THIS message. Bump its per-message
    // revision (aborting its run) instead of the global epoch, so an unrelated
    // in-flight generation of another message keeps running.
    generationCoordinator.bumpMessageRevision(messageId);
    state.panelFocusMsgId = String(messageId);
    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    removeHighlights(mesEl);
    relocateClonedPayload(messageId);
    bg(presentCurrentSwipe(messageId, mesEl), 'presentCurrentSwipe failed:');
}

/**
 * Shared tail of the swipe lifecycle handlers (MESSAGE_SWIPED and
 * MESSAGE_SWIPE_DELETED): re-read the message, apply the false-start guard,
 * and re-present the CURRENT variant (payload hit, rebind, or auto-generate).
 * ST has already spliced msg.swipes/swipe_info and clamped swipe_id when a
 * swipe was deleted, so the current swipe_id is the authoritative slot after
 * either event.
 */
async function presentCurrentSwipe(messageId, mesEl) {
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg || msg.is_user || msg.is_system || msg.is_hidden || !S().enabled) {
        updatePanel();
        return;
    }

    const swipeIdx = msg.swipe_id ?? 0;
    // ⚠ Use swipes[idx] ONLY — do NOT fall back to msg.mes. During an overswipe-
    // regenerate, ST fires MESSAGE_SWIPED in animateSwipe() BEFORE Generate('swipe')
    // streams the new variant: swipe_id is already advanced to the empty new slot
    // (swipes[idx] is undefined / '...'), but msg.mes still holds the OLD swipe's
    // text. Falling back to that stale msg.mes would pass the false-start guard,
    // generate footnotes on STALE content and file them under the new variant's
    // digest. By skipping when the slot is empty we hand generation to the
    // _RENDERED that fires once streaming ends.
    const swipeText = Array.isArray(msg.swipes) ? (msg.swipes[swipeIdx] ?? null) : null;
    const check = (swipeText ?? '').trim();
    if (!swipeText || check === '...' || check.length < MIN_POST_LENGTH) {
        updatePanel();
        return;
    }

    addRegenButton(messageId);
    await presentVariant(messageId, swipeIdx, mesEl);
}

/**
 * MESSAGE_SWIPE_DELETED — a swipe of this message was removed (ported from DS
 * Comments events.js; feature-detected — hosts without the event keep the
 * previous behaviour). Payloads live inside the message objects, so the
 * deleted variant's data dies with the splice; what needs handling is state:
 * an in-flight generation whose target WAS the deleted variant must be
 * aborted, stale markers removed from the DOM, and the now-current variant
 * re-presented (its cached payload restored, or fresh generation kicked off
 * if it never had one).
 */
function onMsgSwipeDeleted({ messageId } = {}) {
    if (messageId === undefined || messageId === null) return;
    generationCoordinator.bumpMessageRevision(messageId);
    // The splice shrank swipes — resync the length cache so the next appending
    // swipe is still detected as one.
    const swipeMsg = getCtx().chat?.[parseInt(messageId)];
    _swipesLen.set(Number(messageId), Array.isArray(swipeMsg?.swipes) ? swipeMsg.swipes.length : 0);
    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    removeHighlights(mesEl);
    panelInvalidate();
    bg(presentCurrentSwipe(messageId, mesEl), 'presentCurrentSwipe failed:');
}

function onMsgEdited(messageId) {
    // An edit changes the message body. Abort this message's in-flight
    // generation (scoped revision), close any popup anchored to the old DOM,
    // and strip the now-stale markers. The payload itself is NOT deleted —
    // MESSAGE_UPDATED (fired by ST after it re-renders the edited message)
    // rebinds the anchors to the new text and re-injects the survivors.
    generationCoordinator.bumpMessageRevision(messageId);
    closePopup();
    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    removeHighlights(mesEl);
    panelInvalidate();
    updatePanel();
    // Hosts without MESSAGE_UPDATED: re-render happens synchronously inside
    // messageEditDone, so a double-rAF lands after the new .mes_text is up.
    // The handle is module-owned so unbindEvents can cancel it — otherwise a
    // disable inside the 2-frame window runs a rebind on a torn-down
    // extension (same class of bug _postChatSwitchTimer fixes).
    if (!_hasUpdatedEvent) {
        if (_editedRaf) cancelAnimationFrame(_editedRaf);
        _editedRaf = requestAnimationFrame(() => {
            _editedRaf = requestAnimationFrame(() => { _editedRaf = 0; onMsgUpdated(messageId); });
        });
    }
}

/**
 * MESSAGE_UPDATED — fired by ST AFTER an edited message has been re-rendered
 * (and before its saveChatConditional), and also when an edit is CANCELLED
 * (messageEditCancel re-renders the original text). Rebind is idempotent: a
 * cancelled edit leaves the digest unchanged and this only re-injects.
 *
 * Translate-guard: ST emits MESSAGE_UPDATED for a translated message's editor
 * too — including a plain "cancel". For an outgoing message the translation
 * REPLACED `mes` (the original lives in extra.display_text), so the digest
 * would mismatch and rebindVariant would orphan EVERY footnote, then stamp the
 * emptied payload back — silently destroying the cache even though the user
 * cancelled. Skip rebind entirely while a translation is on screen; when the
 * user un-translates, the digest re-matches and the cached payload restores.
 */
function onMsgUpdated(messageId) {
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg || msg.is_system || !S().enabled) return;
    if (isTranslatedView(msg)) return;

    const swipeIdx = msg.swipe_id ?? 0;
    const result = rebindVariant(messageId, swipeIdx);
    if (result?.foreign) {
        // Same fall-through as the render path: the payload belonged to ANOTHER
        // variant (ST's slot cloning) and was cleared, so this one regenerates —
        // otherwise an edit that trips the foreign rule would leave the post
        // silently without footnotes and without a lost-anchors banner.
        const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        bg(autoGenerateIfConfigured(messageId, swipeIdx, mesEl), 'autoGenerate after update failed:');
        panelInvalidate();
        updatePanel();
        return;
    }
    if (result) {
        const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (mesEl) {
            removeHighlights(mesEl);
            // Merged read (regular + targeted): injecting result.payload.footnotes
            // alone dropped the targeted entries' markers and block rows after
            // an edit. rebindVariant persists its repair, so a fresh verified
            // read is the same data — now with both kinds.
            const merged = getVariantFootnotes(messageId, swipeIdx);
            if (merged?.length) injectHighlights(mesEl, merged);
        }
    }
    panelInvalidate();
    updatePanel();
}

function onMsgDeleted() {
    // Payloads live inside the message objects, so deletion disposes of them
    // with the message and index shifts move surviving data with its message —
    // no reindex remap is needed (or possible to get wrong) anymore. The host
    // emits only the NEW chat length (script.js:1611) — not a message id — so
    // we re-read ctx.chat instead of trusting a positional payload.
    const ctx = getCtx();
    const chatLen = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    invalidateAiMsgCache();

    // Fix the panel focus pointer: an out-of-range focus is dropped so
    // updatePanel re-picks the best visible AI post instead of pointing at a
    // hole. An in-range focus simply follows the position (the occupant's own
    // payload renders — data is per-message, so it is always the right data).
    const focus = state.panelFocusMsgId;
    if (focus) {
        const fIdx = parseInt(focus);
        if (isNaN(fIdx) || fIdx >= chatLen) state.panelFocusMsgId = null;
    }
    updatePanel();
}

/**
 * MORE_MESSAGES_LOADED — ST's lazy-load ("Show more messages") prepended older
 * .mes nodes that were not in the DOM when restoreHighlightsAll ran at
 * CHAT_CHANGED. Walk the now-present elements and restore markers + regen
 * buttons for any message that didn't get them yet. restoreMessage is
 * idempotent (addRegenButton/injectIfCached/observeForLazyInject all guard
 * against double work), so re-processing already-restored messages is cheap.
 */
function onMoreMessagesLoaded() {
    document.querySelectorAll('.mes[mesid]').forEach(mesEl => restoreMessage(mesEl));
}

/**
 * Auto-generate entry point shared by presentVariant's callers.
 *
 * C3: pre-flight the source config BEFORE calling generateFootnotes. If the
 * source is unconfigured, skip silently and surface ONE info toast per
 * unconfigured episode (state.configWarned), then stay quiet until a real
 * generation succeeds (which clears the flag) - instead of toasting on every
 * new AI message. Manual regenerate (regen button / /glosses regenerate) calls
 * generateFootnotes directly and is NOT guarded, so manual failures still toast
 * every time.
 */
async function autoGenerateIfConfigured(messageId, swipeIdx, mesEl) {
    if (!S().autoGenerate || state.isGenerating[messageId]) return;
    const cfg = await checkSourceConfigured();
    // Re-gate after the await: a sibling present call may already have started
    // a run for this message while the config probe was in flight.
    if (!S().autoGenerate || state.isGenerating[messageId]) return;
    // §6.4: re-record on every check so the floating panel sees the latest
    // result (not just the first unconfigured episode) and can show a
    // persistent "Source not configured" badge instead of silently idling.
    state.configuredState = cfg;
    if (!cfg.ok) {
        if (!state.configWarned) {
            state.configWarned = true;
            globalThis.toastr?.info?.(`[Glosses] ${t('Auto-generation paused: {0}', cfg.reason)}`);
        }
        return;
    }
    state.configWarned = false;
    await generateFootnotes(messageId, swipeIdx, mesEl, { auto: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// SCROLL OBSERVER
// ══════════════════════════════════════════════════════════════════════════════

let _scrollIO = null;
let _scrollMO = null;
let _scrollChatEl = null;
let _scrollHandler = null;
let _observedIds = new Set();
let _observedEls = new Map();
let _pickTimer = null;

// Scroll-follow picking runs only after scrolling STOPS: a trailing debounce
// collapses the IO/scroll event stream into ONE rect pass, so the panel
// re-renders at most once per scroll gesture instead of churning per frame
// (and the render-key cache in renderFootnotesTab dedupes repeat picks of the
// same post). The old per-frame rAF fallback measured every observed post on
// every scroll frame — the main source of the panel's sluggishness.
const SCROLL_PICK_DEBOUNCE_MS = 200;

export function initScrollObserver() {
    _scrollIO?.disconnect(); _scrollIO = null;
    _scrollMO?.disconnect(); _scrollMO = null;
    if (_scrollChatEl && _scrollHandler) {
        _scrollChatEl.removeEventListener('scroll', _scrollHandler);
        _scrollChatEl.removeEventListener('touchend', _scrollHandler);
    }
    if (_pickTimer) { clearTimeout(_pickTimer); _pickTimer = null; }
    _observedIds.clear(); _observedEls.clear();

    // Scroll-follow is a panel-display-mode feature: in inline/popup/both the
    // footnotes are read where they sit, so the panel has no reason to chase
    // the viewport (and paying a re-render per scroll would be pure churn).
    if (!S().floatingPanelEnabled || S().displayMode !== 'panel') return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    _scrollChatEl = chatEl;

    // The IO is only a TRIGGER (nodes entering/leaving the viewport) — the
    // pick itself is a rect pass at fire time, so no ratio map can go stale.
    _scrollIO = new IntersectionObserver(() => schedulePick(), { threshold: 0 });

    observeAllAiMessages();

    _scrollHandler = schedulePick;
    chatEl.addEventListener('scroll', _scrollHandler, { passive: true });
    chatEl.addEventListener('touchend', _scrollHandler, { passive: true });

    // Pick up newly rendered messages without re-scanning the whole chat.
    _scrollMO = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches?.('.mes[mesid]')) observeAiNode(node);
                node.querySelectorAll?.('.mes[mesid]').forEach(observeAiNode);
            }
        }
    });
    _scrollMO.observe(chatEl, { childList: true, subtree: false });
}

function observeAllAiMessages() {
    if (!_scrollIO) return;
    document.querySelectorAll('.mes[mesid]').forEach(observeAiNode);
}

function observeAiNode(el) {
    if (!_scrollIO || !el) return;
    const id = el.getAttribute('mesid');
    if (!id || _observedIds.has(id)) return;
    const msg = getCtx().chat?.[parseInt(id)];
    if (!msg || msg.is_system) return;
    // User posts are scroll-observed (so the panel can follow them) only when
    // glossUserMessages is on.
    if (msg.is_user && !S().glossUserMessages) return;
    _observedIds.add(id);
    _observedEls.set(id, el);
    _scrollIO.observe(el);
}

function schedulePick() {
    if (_pickTimer) clearTimeout(_pickTimer);
    _pickTimer = setTimeout(() => {
        _pickTimer = null;
        pickMostVisible();
    }, SCROLL_PICK_DEBOUNCE_MS);
}

/** Nearest-to-viewport-center annotatable post wins; one pass per scroll stop. */
function pickMostVisible() {
    if (!S().floatingPanelEnabled || S().displayMode !== 'panel') return;
    const vh = window.innerHeight;
    const center = vh / 2;
    let bestId = null, bestDist = Infinity;
    const chat = getCtx().chat;
    const allowUser = S().glossUserMessages;
    for (const id of _observedIds) {
        const msg = chat?.[parseInt(id)];
        if (!msg || msg.is_system) continue;
        if (msg.is_user && !allowUser) continue;
        const el = _observedEls.get(id);
        if (!el || !el.isConnected) {
            _observedIds.delete(id); _observedEls.delete(id);
            continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh) continue;
        const dist = Math.abs(rect.top + rect.height / 2 - center);
        if (dist < bestDist) { bestDist = dist; bestId = id; }
    }
    if (bestId !== null) setVisiblePost(bestId);
}

export function disconnectScrollObserver() {
    if (_postChatSwitchTimer) { clearTimeout(_postChatSwitchTimer); _postChatSwitchTimer = null; }
    _scrollIO?.disconnect(); _scrollIO = null;
    _scrollMO?.disconnect(); _scrollMO = null;
    if (_scrollChatEl && _scrollHandler) {
        _scrollChatEl.removeEventListener('scroll', _scrollHandler);
        _scrollChatEl.removeEventListener('touchend', _scrollHandler);
    }
    if (_pickTimer) { clearTimeout(_pickTimer); _pickTimer = null; }
    _observedIds.clear(); _observedEls.clear();
}
