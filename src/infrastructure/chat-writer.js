// @ts-check
/**
 * Glosses — Chat writer (serialized/coalesced saveChat)
 *
 * Footnote payloads live inside message objects (swipe_info[i].extra.gls /
 * msg.extra.gls), so persisting them means saving the CHAT file, not the chat
 * metadata. This is the same coalescing/serialization/cross-chat-safety
 * contract as the metadata writer (which it reuses), pointed at the host's
 * `ctx.saveChat` — which IS saveChatConditional under its context alias
 * (verified in ST's st-context.js: `saveChat: saveChatConditional`). The old
 * `ctx.saveChatConditional` probe never matched because the context exposes
 * the function only under the `saveChat` name.
 *
 * Chat saves are heavier than metadata saves (the whole chat file is
 * rewritten), so the debounce window is wider and mutations remain rare:
 * one schedule per footnote generation / rebind / manual edit, never per
 * render.
 */

import { getCtx, warn } from '../core.js';
import { createMetadataWriter } from './metadata-writer.js';

let _warnedNoSaveChat = false;

export function createChatWriter({
    getContext = () => getCtx(),
    debounceMs = 500,
    onError,
} = {}) {
    return createMetadataWriter({
        getContext,
        debounceMs,
        onError: onError || ((err) => { console.warn('[Glosses] Failed to save chat:', err); }),
        save: (ctx) => {
            const saveChat = typeof ctx?.saveChat === 'function' ? ctx.saveChat.bind(ctx) : null;
            if (!saveChat) {
                // Exotic hosts may expose no chat persistence method at all.
                if (!_warnedNoSaveChat) {
                    _warnedNoSaveChat = true;
                    warn('No chat persistence API is available — footnote payloads will persist only with SillyTavern\'s own chat saves.');
                }
                return;
            }
            const p = saveChat();
            // Propagate the rejection: the metadata-writer chain awaits the
            // returned promise, so a failed host save reaches onError (→
            // persistenceError → visible toast) instead of vanishing as an
            // unhandled rejection while the user believes footnotes persisted.
            return p;
        },
    });
}
