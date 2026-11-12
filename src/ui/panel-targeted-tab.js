// @ts-check
/**
 * Glosses — Panel «Targeted» tab: per-chat draft, generation run, rendering.
 *
 * Extracted verbatim from window.js (R-7.4 module split). window.js stays the
 * panel owner; this module receives its render hooks through
 * initTargetedTabDeps() (panelInvalidate / updatePanel / getTabController) so
 * no window.js ↔ tab module import cycle exists. makeEntryMain is shared with
 * window.js's footnotes tab and lives here as the single copy.
 */

import {
    state, S, getCtx, t, extractPlainText, notifyUser,
    beginGenerationEpoch, isEpochCurrent, debounce,
} from '../core.js';
import { getVariantPayload, digestFor, saveTargeted, getTargetedDraft, saveTargetedDraft } from '../cache.js';
import { variantText } from '../domain/footnote-payload.js';
import { isAnnotatableMsg } from '../domain/message-identity.js';
import { normalizeAnchorKey } from '../anchor-utils.js';
import {
    parseTargetLines, generateTargetedFootnotes, clearTargetedState, resolveTargetedAnchors,
    MAX_TARGETS,
} from '../targeted-generation.js';
import { reinjectInto } from '../renderer.js';
import { playSound } from '../sound.js';
import { iconHtml } from './icons.js';
import { copyText } from './clipboard.js';
import { uiBusyBegin, uiBusyEnd } from './busy.js';
import { indexToTargetedSymbol, stripLeadingNumber } from '../parser.js';
import { formatFootnoteText } from '../footnote-format.js';

let _deps = { panelInvalidate() {}, updatePanel() {}, getTabController: () => null };

/** Inject the panel-owner hooks (called by window.js buildPanel). */
export function initTargetedTabDeps(deps) { _deps = deps; }

const _targetedState = { input: '', result: null, status: '', requestId: 0, generating: false };

/** Debounced per-chat draft persist (the metadata writer coalesces further).
 * saveTargetedDraft returns the PERSISTED string — shorter than the input when
 * the per-chat storage cap bit, which must not pass silently. Warn once. */
let _draftCapWarned = false;
const saveDraftSoon = debounce(() => {
    try {
        const persisted = saveTargetedDraft(_targetedState.input);
        if (!_draftCapWarned && persisted.length < _targetedState.input.length) {
            _draftCapWarned = true;
            notifyUser('warning', t('The target list draft is longer than per-chat storage keeps; only the first part is saved.'), 'gls-draft-cap');
        }
    } catch { /* non-critical */ }
}, 400);

/**
 * Generate targeted footnotes for the focused message and COMMIT them through
 * the normal payload store: resolve each target against the focused variant's
 * plain text (exact → fuzzy; a miss stays floating), skip targets duplicating
 * a regular footnote of this variant, saveTargeted (digest-guarded), then
 * re-inject the merged marker set on the post.
 */
async function runTargetedGeneration() {
    if (_targetedState.generating) return;
    // Master toggle off = the extension is inert (same contract as
    // generateFootnotes' entry gate).
    if (!S().enabled) return;
    const parsed = parseTargetLines(_targetedState.input);
    if (!parsed.targets.length) {
        _targetedState.status = t('Enter at least one target');
        _deps.getTabController()?.refreshActiveTab();
        return;
    }
    const messageId = state.panelFocusMsgId;
    const message = getCtx().chat?.[parseInt(messageId)];
    const annotatable = isAnnotatableMsg(message);
    if (!annotatable) {
        _targetedState.status = t('Focus a message that can carry footnotes first');
        _deps.getTabController()?.refreshActiveTab();
        return;
    }
    const requestId = ++_targetedState.requestId;
    const parseParts = [];
    if (parsed.duplicateCount) parseParts.push(`${t('Duplicates removed')}: ${parsed.duplicateCount}`);
    if (parsed.truncatedCount) parseParts.push(t('{0} target(s) beyond the {1}-per-run limit were ignored', parsed.truncatedCount, MAX_TARGETS));
    const parseNotice = parseParts.join(' · ');
    _targetedState.generating = true;
    // Busy indicator goes through the shared refcount: a chat switch bumps
    // requestId and this run's finally must STILL release its reference —
    // staleness guards below protect only the state writes, not resources.
    uiBusyBegin();
    // Remember the placeholder so the finally can clear it: the stale-epoch
    // early returns below leave the state untouched, and without the clear the
    // tab would claim "Generating" for a run that already ended.
    const generatingLabel = parseNotice || t('Generating');
    _targetedState.status = generatingLabel;
    _deps.getTabController()?.refreshActiveTab();
    try {
        const { checkSourceConfigured } = await import('../connection.js');
        const cfg = await checkSourceConfigured();
        state.configuredState = cfg;
        if (!cfg.ok) throw new Error(cfg.reason);

        // Custom target language needs a name before any prompt is built
        // (same gate as generateFootnotes).
        const { customLanguageIssue } = await import('../generator.js');
        const langIssue = customLanguageIssue();
        if (langIssue) throw new Error(t(langIssue));

        const swipeIdx = message.swipe_id ?? 0;
        const startDigest = digestFor(messageId, swipeIdx);
        const epoch = beginGenerationEpoch();
        const { assembleStyle, getOutputLanguage } = await import('../generator.js');
        const { buildContextBlocks } = await import('../context-blocks.js');
        const [style, blocks] = await Promise.all([
            assembleStyle(),
            // skipForbidden: explicit user targets must not be second-guessed
            // by the stop-words / forced-ignore lists.
            buildContextBlocks(messageId, swipeIdx, { skipForbidden: true }),
        ]);
        if (requestId !== _targetedState.requestId || !isEpochCurrent(epoch)) return;
        const result = await generateTargetedFootnotes({
            targets: _targetedState.input,
            epoch,
            style,
            outputLanguage: getOutputLanguage(),
            context: blocks.join('\n\n'),
        });
        if (requestId !== _targetedState.requestId || !isEpochCurrent(epoch)) return;
        _targetedState.result = result.stale ? null : result;
        if (result.stale) {
            _targetedState.status = t('Request replaced');
            return;
        }
        if (!result.footnotes.length) {
            // missingTargets excludes rejected (over-cap) targets, so the
            // status never prints a 400+ character line back at the user.
            const parts = [parseNotice];
            if (result.missingTargets.length) parts.push(t('Missing') + ': ' + result.missingTargets.join(', '));
            if (!parts.length) parts.push(t('Enter at least one target'));
            _targetedState.status = parts.join(' · ');
            return;
        }

        // Anchor + persist through the payload store (survives restarts).
        const rawMes = variantText(message, swipeIdx);
        const plain = extractPlainText(rawMes);
        const resolved = resolveTargetedAnchors(
            result.footnotes.map(fn => ({ anchor: fn.anchor, text: fn.text })), plain);
        // Skip targets duplicating a REGULAR footnote of this variant —
        // wrapAnchors dedupes markers by anchor key, so a duplicate would
        // render a panel row whose marker can never appear.
        const payload = getVariantPayload(messageId, swipeIdx);
        const regularKeys = new Set((payload?.footnotes ?? [])
            .map(f => normalizeAnchorKey(f?.anchor)).filter(Boolean));
        const toSave = resolved.filter(e => {
            const k = normalizeAnchorKey(e.anchor);
            return k && !regularKeys.has(k);
        });
        const skipped = resolved
            .filter(e => regularKeys.has(normalizeAnchorKey(e.anchor)))
            .map(e => e.anchor);
        const saved = saveTargeted(messageId, swipeIdx, toSave, { startDigest });
        if (!saved.ok) {
            _targetedState.result = null;
            _targetedState.status = t('The message changed; nothing was saved');
            return;
        }
        // Refresh the post's markers with the merged (regular + targeted) set.
        reinjectInto(messageId, swipeIdx);
        playSound();
        _deps.panelInvalidate();
        const floating = toSave.filter(e => !e.prefix && !e.suffix).length;
        const parts = [];
        if (parseNotice) parts.push(parseNotice);
        if (saved.capped > 0) parts.push(`${t('skipped (variant list is full)')}: ${saved.capped}`);
        if (result.footnotes.length < result.targets.length) {
            parts.push(t('Missing') + ': ' + (result.missingTargets || []).join(', '));
        }
        parts.push(`${t('Saved')} ${toSave.length}/${result.targets.length}`);
        if (floating) parts.push(`${t('not anchored')}: ${floating}`);
        if (skipped.length) parts.push(`${t('skipped (footnote exists)')}: ${skipped.join(', ')}`);
        _targetedState.status = parts.join(' · ');
    } catch (error) {
        if (requestId !== _targetedState.requestId) return;
        _targetedState.status = error?.message || t('Generation failed');
    } finally {
        // Unconditional: begin was unconditional, and the requestId guard may
        // legitimately fail here (chat switch superseded this run). Only the
        // state refresh below stays guarded.
        uiBusyEnd();
        if (requestId === _targetedState.requestId) {
            _targetedState.generating = false;
            if (_targetedState.status === generatingLabel) _targetedState.status = '';
            _deps.getTabController()?.refreshActiveTab();
        }
        _deps.panelInvalidate();
        _deps.updatePanel();
    }
}

export function renderTargetedTab(body) {
    body.classList.toggle('gls-panel--compact', S().panelCompactRows === true);
    // Focus/caret preservation: the tab re-renders on external churn (scroll
    // observer picking a new focused message, new AI posts). Typing must
    // survive it — text lives in _targetedState, focus is restored by hand.
    const active = document.activeElement;
    const wasFocused = active && active.id === 'gls-targeted-input';
    const selStart = wasFocused ? active.selectionStart : null;
    const selEnd = wasFocused ? active.selectionEnd : null;

    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'gls-targeted';
    const label = document.createElement('label');
    label.htmlFor = 'gls-targeted-input';
    label.textContent = t('Targets');
    const input = document.createElement('textarea');
    input.id = 'gls-targeted-input';
    input.rows = 6;
    input.placeholder = t('One target per line');
    input.value = _targetedState.input;
    input.addEventListener('input', () => {
        _targetedState.input = input.value;
        saveDraftSoon();
    });
    const actions = document.createElement('div');
    actions.className = 'gls-targeted-actions';
    const generate = document.createElement('button');
    generate.type = 'button';
    generate.className = 'gls-btn';
    // Busy state: spinner + label swap so the run's start is instantly visible
    // (a bare disabled button read as "nothing happened").
    if (_targetedState.generating) {
        generate.innerHTML = `${iconHtml('spinner', { spin: true })}<span>${t('Generating')}</span>`;
    } else {
        generate.textContent = t('Generate');
    }
    // Disabled state comes from the persistent flag, not a DOM mutation — the
    // old `generate.disabled = true` died with the very next refreshActiveTab
    // rebuild and never actually locked the button.
    generate.disabled = _targetedState.generating;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'gls-btn';
    copy.textContent = t('Copy all');
    copy.disabled = !_targetedState.result?.footnotes?.length;
    copy.addEventListener('click', async () => {
        const text = (_targetedState.result?.footnotes || []).map(f => f.text).join('\n');
        if (!text) return;
        // copyText degrades to execCommand on insecure origins (http LAN) —
        // the feedback must only show on an actual write.
        if (await copyText(text)) {
            const restore = copy.textContent;
            copy.textContent = t('Copied');
            setTimeout(() => {
                copy.textContent = restore;
                copy.disabled = !_targetedState.result?.footnotes?.length;
            }, 1500);
        } else {
            globalThis.toastr?.error?.(t('Copy failed'));
        }
    });
    generate.addEventListener('click', () => { runTargetedGeneration(); });
    actions.append(generate, copy);
    const status = document.createElement('div');
    status.className = 'gls-targeted-status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = _targetedState.status;
    wrap.append(label, input, actions, status);
    for (const fn of _targetedState.result?.footnotes || []) {
        const row = document.createElement('div');
        row.className = 'gls-panel-entry';
        row.append(makeEntryMain(fn, true));
        wrap.appendChild(row);
    }
    body.appendChild(wrap);
    if (wasFocused) {
        input.focus();
        try { input.setSelectionRange(selStart, selEnd); } catch { /* detached */ }
    }
}
/** Shared row content: index/symbol chip + formatted body text. */
export function makeEntryMain(fn, isTargeted) {
    const main = document.createElement('div');
    main.className = 'gls-panel-entry-main';
    const num = document.createElement('span');
    num.className = 'gls-panel-num' + (isTargeted ? ' gls-panel-num--targeted' : '');
    num.textContent = isTargeted ? indexToTargetedSymbol(fn.index) : fn.index;
    const txt = document.createElement('span');
    txt.className = 'gls-panel-text';
    txt.innerHTML = formatFootnoteText(isTargeted ? fn.text : stripLeadingNumber(fn.text));
    main.append(num, txt);
    return main;
}
export function clearTargetedTabState() {
    // Drop a pending draft persist first: its 400ms callback reads
    // _targetedState.input at fire time, which by then already holds the NEW
    // chat's draft — saving it would clobber the freshly loaded draft with a
    // tail of the old one (and the timer must not outlive cleanup either).
    saveDraftSoon.cancel();
    clearTargetedState();
    // The targets draft is per-chat (chatMetadata): reload the NEW chat's
    // draft, drop the old chat's transient result/status, and bump requestId
    // so any in-flight handler from the old chat discards itself.
    _targetedState.input = getTargetedDraft();
    _targetedState.result = null;
    _targetedState.status = '';
    _targetedState.generating = false;
    _targetedState.requestId++;
}
