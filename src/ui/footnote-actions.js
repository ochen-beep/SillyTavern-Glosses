// @ts-check
/**
 * Glosses — Footnote action buttons (Copy / Edit / Delete) — UI layer
 *
 * Shared between the floating footnote panel (src/ui/window.js) and the inline
 * footnote popup (src/renderer.js). Both surfaces operate on the same footnote
 * objects and the same (msgId, swipeIdx, fp) cache context.
 *
 * LAYERING (plan stages 2/7):
 *   - Mutations (edit/delete) are delegated to the application commands in
 *     src/application/footnote-commands.js, which are pure data: exact-context
 *     validation, immutable mutation, persistence. They never touch the DOM.
 *   - The inline editor is the separate component src/ui/footnote-editor.js
 *     (own state machine + disposer). This module only wires it into the action
 *     bar and re-exports it so existing callers keep one import surface.
 *   - This module imports NO renderer.js — the cycle that the previous version
 *     introduced (renderer → footnote-actions → renderer) is gone. DOM refresh
 *     is supplied by the caller, who already owns the renderer reference.
 *
 * Dep edges: icons, core (t), parser (stripLeadingNumber), footnote-editor,
 * clipboard, application/footnote-commands. No window.js, no renderer.js.
 */

import { iconHtml } from './icons.js';
import { t } from '../core.js';
import {
    deleteFootnote,
} from '../application/footnote-commands.js';
import { mountInlineEditor } from './footnote-editor.js';
import { copyText } from './clipboard.js';

// Re-export the editor so the action bar and any caller share one surface.
export { mountInlineEditor };

// ══════════════════════════════════════════════════════════════════════════════
// BUTTON FACTORY + COPY FEEDBACK
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a labelled action button: small icon + text label.
 * @param {string} cls      - CSS class(es) for the button.
 * @param {string} icon     - icon name from the ICONS map (see icons.js).
 * @param {string} label    - visible + tooltip text (already translated).
 * @param {(e: Event) => void} handler
 * @returns {HTMLButtonElement}
 */
export function makeActionButton(cls, icon, label, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.title = label;
    btn.innerHTML = `${iconHtml(icon, { size: 12 })}<span>${label}</span>`;
    btn.addEventListener('click', handler);
    return btn;
}

/**
 * Show a transient "Copied ✓" state on a copy button, then restore it.
 * Idempotent — a second call while feedback is showing is ignored.
 * @param {HTMLButtonElement} btn
 * @param {{ iconSize?: number, doneClass?: string }} [opts]
 */
export function showCopied(btn, { iconSize = 12, doneClass = 'gls-panel-copy--done' } = {}) {
    if (btn.dataset.restore) return; // already showing feedback
    const restore = btn.innerHTML;
    btn.dataset.restore = '1';
    btn.classList.add(doneClass);
    btn.innerHTML = `${iconHtml('check', { size: iconSize })}<span>${t('Copied')}</span>`;
    setTimeout(() => {
        btn.innerHTML = restore;
        btn.classList.remove(doneClass);
        delete btn.dataset.restore;
    }, 1500);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTION BAR — Copy / Edit / Delete, one shape for both surfaces
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the three action buttons for a footnote. Returns them unattached; the
 * caller appends them wherever it wants.
 *
 * `variant` only controls the CSS class token on each button — 'panel' uses the
 * compact borderless style, 'popup' uses the bordered popup style.
 *
 * DOM refresh after a mutation is the caller's responsibility: onRefreshHighlights
 * is invoked with the updated footnotes array so the panel/popup can call
 * removeHighlights + injectHighlights themselves. This module no longer imports
 * renderer.js, breaking the renderer↔footnote-actions cycle.
 *
 * @param {{
 *   fn: any, msgId: string, swipeIdx: number, digest: string,
 *   variant?: 'panel' | 'popup',
 *   editHost: HTMLElement,
 *   validateContext?: () => boolean,
 *   onRefreshHighlights?: (footnotes: any[] | null, msgId: string) => void,
 *   onAfterEdit?: (footnotes: any[], message: any) => void,
 *   onAfterDelete?: () => void,
 *   onAfterCopy?: () => void,
 * }} opts
 * @returns {{ copy: HTMLButtonElement, edit: HTMLButtonElement, del: HTMLButtonElement }}
 */
export function buildFootnoteActions(opts) {
    const variant = opts.variant === 'popup' ? 'popup' : 'panel';
    const kind = opts.kind === 't' ? 't' : 'fn';
    const copyCls = variant === 'popup'
        ? 'gls-popup-action-btn gls-popup-copy'
        : 'gls-panel-copy';
    const editCls = variant === 'popup'
        ? 'gls-popup-action-btn gls-popup-edit'
        : 'gls-panel-edit';
    const delCls = variant === 'popup'
        ? 'gls-popup-action-btn gls-popup-del'
        : 'gls-panel-del';
    const copyDoneCls = variant === 'popup'
        ? 'gls-popup-action-btn--done'
        : 'gls-panel-copy--done';

    // Copy: gate the "Copied ✓" feedback on an actual write. On insecure
    // origins (http LAN access — the typical mobile ST setup) the async
    // Clipboard API doesn't exist and copyText degrades to execCommand; the
    // old `await navigator.clipboard?.writeText()` resolved to undefined there
    // and showed a false success (plan §1).
    const copy = makeActionButton(copyCls, 'copy', t('Copy'), async () => {
        const ok = await copyText(opts.fn.text);
        if (ok) {
            showCopied(copy, { doneClass: copyDoneCls });
            opts.onAfterCopy?.();
        } else {
            toastr?.error?.(t('Copy failed'));
        }
    });
    const edit = makeActionButton(editCls, 'pen', t('Edit'), () => {
        // A repeated tap while the editor is already mounted (the popup keeps
        // its header mounted over the editor body) must not re-mount and wipe
        // the in-progress draft — focus the live textarea instead.
        const live = opts.editHost.querySelector?.('textarea.gls-panel-edit-input');
        if (live) { live.focus?.(); return; }
        mountInlineEditor(opts.editHost, {
            fn: opts.fn,
            msgId: opts.msgId,
            swipeIdx: opts.swipeIdx,
            digest: opts.digest,
            kind,
            validateContext: opts.validateContext,
            onSaved: opts.onAfterEdit,
            onCancelled: opts.onAfterEdit,
        });
    });
    // Delete enforces the SAME exact-context contract as Edit.
    const del = makeActionButton(delCls, 'xmark', t('Delete'), () => {
        const result = deleteFootnote({
            msgId: opts.msgId,
            swipeIdx: opts.swipeIdx,
            digest: opts.digest,
            fn: opts.fn,
            footnoteId: opts.fn.index,
            kind,
            validateContext: opts.validateContext,
        });
        if (!result.ok) {
            if (result.reason === 'stale') {
                toastr?.warning?.(t('The message changed; delete was cancelled'));
            }
            return;
        }
        // null footnotes signals "entry emptied" — caller should clear the DOM.
        opts.onRefreshHighlights?.(result.emptied ? null : result.footnotes, result.msgId);
        opts.onAfterDelete?.();
    });
    return { copy, edit, del };
}
