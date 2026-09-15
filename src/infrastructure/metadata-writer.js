// @ts-check
/**
 * Glosses — Serialized/coalesced metadata writer (plan stage 5)
 *
 * Wraps the host `saveMetadata()` contract so mutations are persisted safely:
 *
 *   - SERIALIZATION: only one saveMetadata() runs at a time. A mutation that
 *     arrives while a save is in flight is queued and flushed after, so the
 *     newest revision is never dropped by an older completion.
 *   - COALESCING: rapid mutations collapse into one save per tick instead of
 *     N saves (ST's saveMetadata writes the whole chatMetadata blob).
 *   - REVISION SAFETY: an in-flight save completion does NOT clear the dirty
 *     flag if a newer mutation landed meanwhile (the "old completion must not
 *     clear the dirty state of a new revision" requirement).
 *   - ERROR DEDUP: persistence errors notify at most once per window instead of
 *     spamming the console/toast on every retry.
 *   - BOUNDED FLUSH: flush()/flushNow() let page-hide / cleanup persist pending
 *     work without unbounded queue growth.
 *   - CROSS-CHAT SAFETY: chatId is captured at schedule time; at flush time the
 *     current context is re-read and if the chat changed the pending write is
 *     dropped (ST re-persists per-chat metadata on switch; saving the old
 *     chat's metadata through the new chat's context must never happen).
 *
 * The writer is host-agnostic: it takes a getContext accessor so it never
 * caches the ST context (which becomes stale after CHAT_CHANGED).
 */

/**
 * @typedef {Object} MetadataWriterDeps
 * @property {() => any} getContext - returns the CURRENT ST context (re-read
 *   every flush; never cached).
 * @property {number} [debounceMs] - coalescing window in ms (default 200).
 * @property {(err: unknown) => void} [onError] - deduped error sink.
 * @property {(ctx: any) => void} [save] - the host save call to invoke.
 *   Defaults to `ctx.saveMetadata?.()`. The chat-writer instance overrides it
 *   with `ctx.saveChat?.()` so per-message footnote payloads persist with the
 *   chat file while the metadata instance keeps persisting chatMetadata.
 */

/**
 * @param {MetadataWriterDeps} deps
 */
export function createMetadataWriter({ getContext, debounceMs = 200, onError = () => {}, save }) {
    const saveFn = typeof save === 'function' ? save : (ctx) => ctx.saveMetadata?.();
    /** @type {Promise<void>} chain of in-flight saves */
    let chain = Promise.resolve();
    /** @type {{ chatId: unknown } | null} pending dirty revision (chatId at schedule time) */
    let pending = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {number} timestamp of the last error notification (dedup window) */
    let lastErrorAt = 0;
    /** @type {boolean} a save is currently running (not just queued) */
    let inFlight = false;

    function notifyError(err) {
        const now = Date.now();
        if (now - lastErrorAt < 5000) return; // at most once per 5s
        lastErrorAt = now;
        onError(err);
    }

    /** Persist the pending revision (if any) against the CURRENT context. */
    function doSave() {
        inFlight = true;
        const batch = pending;
        pending = null; // cleared here; a mutation during the save re-dirties
        return chain
            .catch(() => {}) // swallow prior rejection; the batch still runs
            .then(async () => {
                if (!batch) return;
                const ctx = getContext();
                // Cross-chat guard: the chat switched since schedule → drop.
                if (ctx?.chatId !== batch.chatId) return;
                try {
                    // Await so an async host save (saveMetadata/saveChat return
                    // promises) serializes on the chain AND its rejection lands
                    // in the catch below — a bare call() only surfaced
                    // synchronous throws and silently dropped real failures.
                    await saveFn(ctx);
                } catch (err) {
                    notifyError(err);
                }
            })
            .then(() => {
                inFlight = false;
                // A mutation landed while we were saving → flush it next.
                if (pending) return flush();
            });
    }

    /** Coalesced flush: debounced after the first schedule within a window. */
    function schedule() {
        const ctx = getContext();
        pending = { chatId: ctx?.chatId ?? 'no-chat' };
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            chain = doSave();
        }, debounceMs);
    }

    /**
     * Persist any pending work immediately (bounded). Returns a promise that
     * resolves when the save chain has settled. Used by page-hide and cleanup.
     */
    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (pending || inFlight) {
            chain = doSave();
        }
        return chain;
    }

    return {
        schedule,
        flush,
        /** True when a mutation is dirty or a save is in flight. */
        isPending: () => !!pending || inFlight || !!timer,
    };
}
