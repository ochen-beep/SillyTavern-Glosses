// @ts-check
/**
 * Glosses — Inline footnote editor component (plan stages 2.4 / 7)
 *
 * The inline textarea editor shared by the floating panel and the footnote
 * popup. Extracted from footnote-actions.js so the action bar module stays a
 * thin presenter: this component owns the editor DOM, its lifecycle and its
 * keyboard behaviour.
 *
 * State machine (plan §2.4):
 *
 *   viewing → editing → saving → viewing | error | stale | cancelled
 *
 *   - viewing:    no editor mounted (the caller renders the footnote row).
 *   - editing:    textarea mounted, Save/Cancel visible.
 *   - saving:     Save pressed; the editFootnote command is running. Save +
 *                 Cancel are disabled so a double-click can't fire two edits.
 *   - saved:      editFootnote ok → onSaved(footnotes, message) → caller
 *                 re-renders (back to viewing).
 *   - error:      empty text → toast, stay in editing (input preserved).
 *                 storage write failed → toast, stay in editing, buttons
 *                 re-enabled (retryable — the draft is intact).
 *   - stale:      message changed under us → toast + onCancelled() (back to
 *                 viewing, caller re-resolves context).
 *
 * Ownership / disposal:
 *   - mount(host, opts) replaces the host's contents and returns a disposer.
 *   - The disposer removes all listeners this component attached (textarea
 *     keydown, Save/Cancel clicks, document-level Escape fallback) so a
 *     teardown mid-edit leaks nothing.
 *   - Escape cancels the edit and the caller restores focus (plan §2.4).
 *
 * Deps: icons, core (t), parser (stripLeadingNumber), application commands.
 * No renderer, no window.js — DOM refresh is the caller's job.
 */

import { t } from '../core.js';
import { stripLeadingNumber } from '../parser.js';
import { editFootnote, beginEditEpoch } from '../application/footnote-commands.js';

/** @typedef {'editing' | 'saving'} EditorPhase */

/**
 * Mount an inline textarea editor into `hostEl`, replacing its contents.
 *
 * @param {HTMLElement} hostEl - element whose contents are replaced by the editor
 * @param {{
 *   fn: any, msgId: string, swipeIdx: number, digest: string,
 *   kind?: 'fn' | 't',
 *   validateContext?: () => boolean,
 *   onSaved?: (footnotes: any[], message: any) => void,
 *   onCancelled?: () => void,
 * }} opts
 * @returns {() => void} disposer — removes all listeners this component attached.
 */
export function mountInlineEditor(hostEl, opts) {
    const { fn, msgId, swipeIdx, digest, kind, validateContext, onSaved, onCancelled } = opts;
    const editEpoch = beginEditEpoch();
    /** @type {EditorPhase} */
    let phase = 'editing';

    // ── DOM ──
    hostEl.innerHTML = '';

    const anchor = document.createElement('div');
    anchor.className = 'gls-panel-edit-anchor';
    anchor.textContent = fn.anchor;

    const inputLabel = document.createElement('label');
    inputLabel.className = 'gls-sr-only';
    inputLabel.htmlFor = `gls-footnote-edit-${msgId}-${kind || 'fn'}-${fn.index}`;
    inputLabel.textContent = t('Footnote text');

    const input = document.createElement('textarea');
    input.id = inputLabel.htmlFor;
    input.className = 'gls-panel-edit-input';
    // Regular bodies carry a numeric prefix the editor must strip; targeted
    // bodies are prefix-free, so the strip is a harmless no-op there.
    input.value = stripLeadingNumber(fn.text);
    input.rows = 3;

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'gls-btn';
    save.textContent = t('Save');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    // gls-edit-cancel: the popup keydown handler delegates Escape here when
    // focus is anywhere outside the textarea (whose own keydown handles it).
    cancel.className = 'gls-btn gls-edit-cancel';
    cancel.textContent = t('Cancel');

    const actions = document.createElement('div');
    actions.className = 'gls-panel-edit-actions';
    actions.append(save, cancel);

    hostEl.append(anchor, inputLabel, input, actions);
    input.focus?.();

    // ── Actions ──
    /** Guard the phase machine: no-op once we've left 'editing'. */
    const commit = () => {
        phase = 'saving';
        save.disabled = true;
        cancel.disabled = true;
    };

    const handleSave = () => {
        if (phase !== 'editing') return; // saving in flight / already left
        commit();
        const result = editFootnote({
            msgId, swipeIdx, digest, fn, footnoteId: fn.index,
            kind, text: input.value,
            editEpoch,
            validateContext,
        });
        if (result.ok) {
            onSaved?.(result.footnotes, result.message);
            return; // caller re-renders → back to viewing
        }
        if (result.reason === 'empty') {
            // Stay in editing; re-enable the buttons so the user can fix it.
            phase = 'editing';
            save.disabled = false;
            cancel.disabled = false;
            toastr?.warning?.(t('Footnote text is required'));
            return;
        }
        if (result.reason === 'persistence-error') {
            // The write failed (not a staleness problem) — keep the editor
            // open with the draft intact so the user can retry.
            phase = 'editing';
            save.disabled = false;
            cancel.disabled = false;
            toastr?.error?.(t('Could not save the edit; try again'));
            return;
        }
        // 'stale' / 'not-found' — the message or the footnote moved under us;
        // bail and let the caller reset.
        phase = 'editing';
        save.disabled = false;
        cancel.disabled = false;
        toastr?.warning?.(t('The message changed; edit was cancelled'));
        onCancelled?.();
    };

    const handleCancel = () => {
        if (phase === 'saving') return; // never cancel mid-commit
        onCancelled?.();
    };

    const handleKeydown = (e) => {
        // Escape cancels the edit (plan §2.4). Scoped to the textarea so a
        // popup-level Escape handler still owns the "close popup" case.
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
    };

    save.addEventListener('click', handleSave);
    cancel.addEventListener('click', handleCancel);
    input.addEventListener('keydown', handleKeydown);

    // ── Disposer ──
    return () => {
        save.removeEventListener('click', handleSave);
        cancel.removeEventListener('click', handleCancel);
        input.removeEventListener('keydown', handleKeydown);
        // Leave the DOM in place (the caller decides whether to clear hostEl);
        // we only guarantee no listener survives.
    };
}
