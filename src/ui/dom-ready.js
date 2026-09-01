// @ts-check
/**
 * Glosses — DOM-ready helper.
 *
 * Run `attach(sendForm)` once #send_form is available. #send_form is core
 * SillyTavern UI, guaranteed present by the time event_types.APP_READY fires
 * (script.js firstLoadInit: initExtensions() -> APP_INITIALIZED ->
 * initLoaderHandle.hide() -> fixViewport() -> APP_READY). If #send_form
 * already exists (post-ready enable, or APP_READY already fired), attach
 * synchronously; otherwise subscribe to APP_READY and attach on the event.
 *
 * Polling is deliberately avoided (ported from DS Comments src/ui/dom-ready.js,
 * which replaced its own setInterval polling for exactly this reason): waiting
 * on APP_READY instead of a timer gives event-driven attach with no deadline.
 * Idempotent: safe to call on every init; the caller guards its own observer
 * with a once-flag.
 *
 * Returns a disposer: callers MUST store it and invoke it in their teardown
 * path. Without this, an extension disabled BEFORE APP_READY leaves the
 * listener alive, and the later event attaches orphaned observers + the
 * launcher button after teardown.
 */

import { getCtx, warn } from '../core.js';

/**
 * @param {(sendForm: HTMLElement) => void} attach run once #send_form is available.
 * @param {{ onGiveUp?: () => void }} [options] - onGiveUp fires if APP_READY is
 *   unavailable and #send_form is absent (older/odd build); the extension
 *   remains functional (panel, slash commands) but the launcher/chrome won't
 *   attach until a later chat event.
 * @returns {() => void} disposer — always a function; removes the APP_READY
 *   listener if one was subscribed. Safe to call after attach or more than once.
 */
export function whenSendFormReady(attach, { onGiveUp } = {}) {
    const sendForm = document.getElementById('send_form');
    if (sendForm) { attach(sendForm); return () => {}; }

    const ctx = getCtx();
    const eventSource = ctx?.eventSource;
    // event_types is the surface Glosses uses everywhere (and the one older
    // ST builds expose); eventTypes is the camelCase alias on newer builds.
    const readyEvent = ctx?.event_types?.APP_READY ?? ctx?.eventTypes?.APP_READY;
    if (!eventSource || !readyEvent) {
        // No APP_READY surface: nothing to wait on. The extension still works
        // (panel, slash commands); the launcher/chrome simply won't attach
        // until a later chat event re-runs init. Warn once for diagnostics.
        warn('whenSendFormReady: APP_READY unavailable and #send_form not yet present');
        onGiveUp?.();
        return () => {};
    }

    const handler = () => {
        eventSource.removeListener(readyEvent, handler);
        const sf = document.getElementById('send_form');
        if (sf) attach(sf);
        else onGiveUp?.();
    };
    eventSource.on(readyEvent, handler);
    // Unified disposer contract: always a function, safe to call after the
    // handler already removed itself on APP_READY.
    return () => { try { eventSource.removeListener(readyEvent, handler); } catch { /* already removed */ } };
}
