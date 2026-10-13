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
 * @param {{ iconSize?: number, iconOnly?: boolean }} [opts]
 *        iconOnly drops the text label (title/aria-label still carry it for
 *        a11y + tooltips) — the popup header uses this so oversized popup
 *        fonts can't stretch the card with three long words.
 * @returns {HTMLButtonElement}
 */
export function makeActionButton(cls, icon, label, handler, { iconSize = 12, iconOnly = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = iconOnly
        ? iconHtml(icon, { size: iconSize })
        : `${iconHtml(icon, { size: iconSize })}<span>${label}</span>`;
    btn.addEventListener('click', handler);
    return btn;
}

/**
 * Show a transient "Copied ✓" state on a copy button, then restore it.
 * Idempotent — a second call while feedback is showing is ignored.
 * @param {HTMLButtonElement} btn
 * @param {{ iconSize?: number, doneClass?: string, labelled?: boolean }} [opts]
 *        labelled=false mirrors an icon-only button: the check icon alone
 *        (accent-tinted via doneClass) carries the feedback.
 */
export function showCopied(btn, { iconSize = 12, doneClass = 'gls-panel-copy--done', labelled = true } = {}) {
    if (btn.dataset.restore) return; // already showing feedback
    const restore = btn.innerHTML;
    btn.dataset.restore = '1';
    btn.classList.add(doneClass);
    btn.innerHTML = `${iconHtml('check', { size: iconSize })}${labelled ? `<span>${t('Copied')}</span>` : ''}`;
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
 *   onEditCancelled?: () => void,
 *   onEditStarted?: () => void,
 *   onAfterDelete?: () => void,
 *   onAfterCopy?: () => void,
 * }} opts
 * @returns {{ copy: HTMLButtonElement, edit: HTMLButtonElement, del: HTMLButtonElement }}
 */
export function buildFootnoteActions(opts) {
    const variant = opts.variant === 'popup' ? 'popup' : 'panel';
    const kind = opts.kind === 't' ? 't' : 'fn';
    // Popup header: icon-only buttons at a larger size — long labels
    // ("Копировать/Редактировать/Удалить") at big popup fonts used to stretch
    // the card; labels survive as title/aria-label tooltips. The panel keeps
    // the labelled compact style (rows have room, and labels aid scanning).
    const iconOnly = variant === 'popup';
    const iconSize = iconOnly ? 16 : 12;
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
            showCopied(copy, { doneClass: copyDoneCls, iconSize, labelled: !iconOnly });
            opts.onAfterCopy?.();
        } else {
            globalThis.toastr?.error?.(t('Copy failed'));
        }
    }, { iconSize, iconOnly });
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
            // Saved and cancelled are different outcomes. The panel re-renders
            // the row either way (its onAfterEdit is a re-render), but the
            // POPUP used to close on a bare cancel — onAfterEdit there is
            // closePopup, because after a SAVE the payload changed. Surfaces
            // that want cancel-to-stay-open pass onEditCancelled (renderer.js).
            onCancelled: opts.onEditCancelled || opts.onAfterEdit,
        });
        opts.onEditStarted?.();
    }, { iconSize, iconOnly });
    // Delete: trash glyph — a bare ✕ read as "close this footnote" next to the
    // header's actual close button.
    const del = makeActionButton(delCls, 'trash', t('Delete'), () => {
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
                globalThis.toastr?.warning?.(t('The message changed; delete was cancelled'));
            }
            return;
        }
        // null footnotes signals "entry emptied" — caller should clear the DOM.
        opts.onRefreshHighlights?.(result.emptied ? null : result.footnotes, result.msgId);
        opts.onAfterDelete?.();
    }, { iconSize, iconOnly });
    return { copy, edit, del };
}
