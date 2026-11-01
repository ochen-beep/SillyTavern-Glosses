// @ts-check
/**
 * Glosses — Panel «Exclusions» tab: forced-ignore list + glossed-anchors pool.
 *
 * Extracted verbatim from window.js (R-7.4 module split). Panel-owner hooks
 * (panelInvalidate / getTabController) arrive through initExclusionsTabDeps()
 * — see panel-targeted-tab.js for the rationale.
 */

import { S, getCtx, saveSettings, showConfirmModal, t } from '../core.js';
import {
    getForcedIgnore, saveForcedIgnore, getPoolExcluded, togglePoolExcluded,
    clearAll, listFootnoteSets,
} from '../cache.js';
import { renumberFootnotes } from '../application/footnote-commands.js';
import { targetedOf, reindexTargeted } from '../domain/footnote-payload.js';
import { normalizeAnchorKey } from '../anchor-utils.js';
import { removeHighlights, reinjectInto } from '../renderer.js';
import { makeActionButton } from './footnote-actions.js';

let _deps = { panelInvalidate() {}, getTabController: () => null };

/** Inject the panel-owner hooks (called by window.js buildPanel). */
export function initExclusionsTabDeps(deps) { _deps = deps; }

export function renderExclusionsTab(body) {
    body.innerHTML = '';
    const s = S();

    // ── Auto-avoidance toggle ──
    const avoidWrap = document.createElement('div');
    avoidWrap.className = 'gls-excl-row';
    const avoidLabel = document.createElement('label');
    avoidLabel.className = 'gls-excl-toggle-label';
    const avoidCheck = document.createElement('input');
    avoidCheck.type = 'checkbox';
    avoidCheck.checked = s.avoidRepeatedAnchors !== false;
    avoidCheck.addEventListener('change', () => {
        s.avoidRepeatedAnchors = avoidCheck.checked;
        saveSettings();
    });
    avoidLabel.append(avoidCheck, document.createTextNode(' ' + t('Suggest new anchors when possible')));
    avoidWrap.appendChild(avoidLabel);

    // ── Forced-ignore list ──
    const label = document.createElement('label');
    label.htmlFor = 'gls-forced-ignore';
    label.textContent = t('Never create footnotes for');
    const input = document.createElement('textarea');
    input.id = 'gls-forced-ignore';
    input.value = getForcedIgnore().join('\n');
    const help = document.createElement('div');
    help.className = 'gls-excl-help';
    help.textContent = t('One phrase per line. Changes apply to future generations only.');
    const actions = document.createElement('div');
    actions.className = 'gls-excl-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'gls-btn';
    save.textContent = t('Apply');
    const status = document.createElement('span');
    status.className = 'gls-excl-status';
    status.setAttribute('aria-live', 'polite');
    save.addEventListener('click', () => {
        const normalized = saveForcedIgnore(input.value.split(/\r?\n/));
        input.value = normalized.join('\n');
        status.textContent = t('Saved');
        setTimeout(() => { if (status.textContent === t('Saved')) status.textContent = ''; }, 2000);
    });
    actions.append(save, status);
    body.append(avoidWrap, label, input, help, actions);

    body.append(buildPoolSection());
}

/**
 * Build the "Glossed anchors pool" manager section: a scrollable list of every
 * unique anchor Glosses has ever generated for this chat, each with two actions
 * — delete the footnote outright, or hide the anchor from the advisory pool
 * (footnote stays in its post). Anchors already hidden from the pool surface in
 * a separate "Excluded from pool" block with an undo action.
 *
 * The list mirrors collectExplainedAnchors' de-dup (normalized key) and newest-
 * first ordering, but unlike the prompt collector it INCLUDES the focused
 * message's anchors (the manager shows the whole pool) and splits out hidden
 * ones rather than dropping them.
 */
function buildPoolSection() {
    const wrap = document.createElement('div');
    wrap.className = 'gls-pool-wrap';

    // Collect unique anchors across ALL verified payloads (including the
    // focused message), both regular and targeted entries. listFootnoteSets
    // returns newest-msgId-first, which is the order the panel wants (first
    // occurrence wins for display).
    const seen = new Set();
    const excludedKeys = new Set(getPoolExcluded().map(normalizeAnchorKey));
    const activeAnchors = [];   // {anchor, key} — visible in the pool
    const excludedAnchors = []; // {anchor} — hidden from the advisory block
    for (const set of listFootnoteSets()) {
        for (const fn of [...(set.footnotes || []), ...(set.targeted || [])]) {
            const anchor = String(fn?.anchor ?? '').trim();
            const key = normalizeAnchorKey(anchor);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            if (excludedKeys.has(key)) excludedAnchors.push({ anchor });
            else activeAnchors.push({ anchor, key });
        }
    }

    // ── Header: title + count + clear-all ──
    const header = document.createElement('div');
    header.className = 'gls-excl-row';
    const title = document.createElement('label');
    title.textContent = `${t('Glossed anchors pool')} (${activeAnchors.length})`;
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'gls-pool-clear gls-btn';
    clearBtn.textContent = t('Clear pool');
    clearBtn.disabled = activeAnchors.length === 0 && excludedAnchors.length === 0;
    clearBtn.addEventListener('click', async () => {
        if (!await showConfirmModal(t('Delete ALL footnotes in this chat?'))) return;
        // Wipes every per-variant payload + pool-excluded list (+ the legacy
        // metadata entries) in one persisted pass per writer.
        clearAll({ clearPoolExcluded: true });
        // Drop highlights from every visible message, then refresh.
        document.querySelectorAll('.mes[mesid]').forEach(mesEl => removeHighlights(mesEl));
        _deps.panelInvalidate();
        _deps.getTabController()?.refreshActiveTab();
    });
    const headerActions = document.createElement('div');
    headerActions.className = 'gls-excl-actions';
    headerActions.appendChild(clearBtn);
    header.append(title, headerActions);

    wrap.append(header);

    // ── Active pool list ──
    const list = document.createElement('div');
    list.className = 'gls-pool-list';
    if (activeAnchors.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gls-pool-empty';
        empty.textContent = excludedAnchors.length
            ? t('Pool is empty (all anchors excluded)')
            : t('No glossed anchors yet');
        list.appendChild(empty);
    } else {
        for (const { anchor, key } of activeAnchors) {
            list.appendChild(makePoolRow(anchor, {
                buttons: [
                    makeActionButton('gls-panel-del', 'trash', t('Delete footnote'), () => deleteAnchorFromPool(key)),
                    makeActionButton('gls-panel-copy', 'ban', t('Exclude from pool'), () => { togglePoolExcluded(anchor, true); _deps.getTabController()?.refreshActiveTab(); }),
                ],
            }));
        }
    }
    wrap.appendChild(list);

    // ── Excluded-from-pool block (undo list) ──
    if (excludedAnchors.length) {
        const exclTitle = document.createElement('label');
        exclTitle.className = 'gls-pool-excl-title';
        exclTitle.textContent = `${t('Excluded from pool')} (${excludedAnchors.length})`;
        const exclList = document.createElement('div');
        exclList.className = 'gls-pool-list gls-pool-list--excluded';
        for (const { anchor } of excludedAnchors) {
            exclList.appendChild(makePoolRow(anchor, {
                excluded: true,
                buttons: [makeActionButton('gls-panel-copy', 'rotate-ccw', t('Restore'), () => { togglePoolExcluded(anchor, false); _deps.getTabController()?.refreshActiveTab(); })],
            }));
        }
        wrap.append(exclTitle, exclList);
    }

    return wrap;
}
/** One pool-list row: anchor text + the given action buttons. */
function makePoolRow(anchor, { excluded = false, buttons = [] }) {
    const row = document.createElement('div');
    row.className = 'gls-pool-item' + (excluded ? ' gls-pool-item--excluded' : '');
    const text = document.createElement('span');
    text.className = 'gls-pool-anchor';
    text.textContent = anchor;
    text.title = anchor;
    const actions = document.createElement('div');
    actions.className = 'gls-pool-item-actions';
    actions.append(...buttons);
    row.append(text, actions);
    return row;
}

/**
 * Thin boolean wrapper over the guarded payload mutation for pool-wide edits:
 * the mutator returns `undefined` for "anchor not in this variant — leave it
 * alone" (distinct from null = abort). The probe runs first so variants the
 * anchor doesn't live in skip the write entirely. `opts.kind` selects the
 * mutated array ('fn' regular / 't' targeted).
 */
function mutateFootnoteSet(msgId, swipeIdx, digest, mutator, opts = {}) {
    const payload = getVariantPayload(msgId, swipeIdx);
    if (!payload) return false;
    const pool = opts.kind === 't' ? targetedOf(payload) : payload.footnotes;
    const probe = mutator(pool);
    if (probe === undefined || probe === pool) return false;
    const result = mutateFootnotes(msgId, swipeIdx, digest, () => probe, opts);
    return !!result.ok;
}

/**
 * Delete every footnote whose anchor matches `key` (normalized) across the
 * whole chat — every message, every variant, both kinds — renumbering /
 * reindexing each affected payload and refreshing its rendered post. Uses the
 * guarded payload mutation (mutateFootnotes via a small facade wrapper) so
 * persistence coalesces and stale variants can't be written.
 */
function deleteAnchorFromPool(key) {
    const affectedMsgIds = new Set();
    for (const set of listFootnoteSets()) {
        const digest = digestFor(set.msgId, set.swipeIdx);
        if (!digest) continue;
        let touched = false;
        touched = mutateFootnoteSet(set.msgId, set.swipeIdx, digest, (footnotes) => {
            const filtered = footnotes.filter(f => normalizeAnchorKey(f?.anchor) !== key);
            if (filtered.length === footnotes.length) return undefined; // anchor not here
            return renumberFootnotes(filtered);
        }) || touched;
        touched = mutateFootnoteSet(set.msgId, set.swipeIdx, digest, (entries) => {
            const filtered = entries.filter(e => normalizeAnchorKey(e?.anchor) !== key);
            if (filtered.length === entries.length) return undefined;
            return reindexTargeted(filtered);
        }, { kind: 't' }) || touched;
        if (touched) affectedMsgIds.add(set.msgId);
    }
    if (affectedMsgIds.size === 0) return;
    _deps.panelInvalidate();
    // Re-render each affected post's highlights (merged: regular + targeted).
    for (const msgId of affectedMsgIds) {
        const msg = getCtx().chat?.[parseInt(msgId)];
        if (!msg) continue;
        reinjectInto(msgId, msg.swipe_id ?? 0);
    }
    _deps.getTabController()?.refreshActiveTab();
}
