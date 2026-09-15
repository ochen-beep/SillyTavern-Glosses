// @ts-check
/**
 * Glosses — UI: Floating panel
 * Draggable/resizable side panel that lists footnotes for the focused message,
 * with prev/next navigation, copy/delete per row, and a clear-all control.
 *
 * Ported 1:1 from SillyTavern-Footnotes (buildPanel/destroyPanel/updatePanel/
 * renderPanel/navigatePanel/deleteSingleFootnote + layout persistence).
 *
 * Render caching: the panel stores a `data-render-key` on the DOM node and skips
 * a full re-render when the key matches — so scroll/visibility churn doesn't
 * thrash the DOM. Call panelInvalidate() to force the next renderPanel to run.
 */

import {
    state, S, getCtx, saveSettings, showConfirmModal, t, extractPlainText,
    PANEL_LAYOUT_KEY, MOBILE_BREAKPOINT, beginGenerationEpoch, isEpochCurrent,
} from '../core.js';
import {
    getVariantFootnotes, getVariantPayload, digestFor, clearAll, clearVariant,
    mutateFootnotes, saveTargeted, getTargetedDraft, saveTargetedDraft,
    getForcedIgnore, saveForcedIgnore, getPoolExcluded, togglePoolExcluded,
    listFootnoteSets,
} from '../cache.js';
import { targetedOf } from '../domain/footnote-payload.js';
import { removeHighlights, injectHighlights, formatFootnoteText } from '../renderer.js';
import { indexToTargetedSymbol, stripLeadingNumber } from '../parser.js';
import { normalizeAnchorKey } from '../anchor-utils.js';
import { renumberFootnotes, reindexTargeted } from '../application/footnote-commands.js';
import { whenSendFormReady } from './dom-ready.js';
import { createTabController } from './tabs.js';
import { copyText } from './clipboard.js';
import {
    parseTargetLines, generateTargetedFootnotes, clearTargetedState,
    resolveTargetedAnchors,
} from '../targeted-generation.js';
import { playSound } from '../sound.js';
import { iconHtml } from './icons.js';
import { detectEmptyReason, renderEmptyStateHTML } from './empty.js';
import { buildFootnoteActions } from './footnote-actions.js';

let _floatingPanel = null;
let _tabController = null;
const _targetedState = { input: '', result: null, status: '', requestId: 0, generating: false };

/** Debounced per-chat draft persist (the metadata writer coalesces further). */
let _draftSaveTimer = null;
function saveDraftSoon() {
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
        _draftSaveTimer = null;
        try { saveTargetedDraft(_targetedState.input); } catch { /* non-critical */ }
    }, 400);
}

/**
 * Generate targeted footnotes for the focused message and COMMIT them through
 * the normal payload store: resolve each target against the focused variant's
 * plain text (exact → fuzzy; a miss stays floating), skip targets duplicating
 * a regular footnote of this variant, saveTargeted (digest-guarded), then
 * re-inject the merged marker set on the post.
 */
async function runTargetedGeneration() {
    if (_targetedState.generating) return;
    const parsed = parseTargetLines(_targetedState.input);
    if (!parsed.targets.length) {
        _targetedState.status = t('Enter at least one target');
        _tabController?.refreshActiveTab();
        return;
    }
    const messageId = state.panelFocusMsgId;
    const message = getCtx().chat?.[parseInt(messageId)];
    const annotatable = Boolean(message) && !message.is_system
        && (S().glossUserMessages ? true : !message.is_user);
    if (!annotatable) {
        _targetedState.status = t('Focus a message that can carry footnotes first');
        _tabController?.refreshActiveTab();
        return;
    }
    const requestId = ++_targetedState.requestId;
    const parseNotice = parsed.duplicateCount || parsed.truncatedCount
        ? t('Duplicates removed, excess truncated') : '';
    _targetedState.generating = true;
    _targetedState.status = parseNotice || t('Generating');
    _tabController?.refreshActiveTab();
    try {
        const { checkSourceConfigured } = await import('../connection.js');
        const cfg = await checkSourceConfigured();
        state.configuredState = cfg;
        if (!cfg.ok) throw new Error(cfg.reason);

        const swipeIdx = message.swipe_id ?? 0;
        const startDigest = digestFor(messageId, swipeIdx);
        const epoch = beginGenerationEpoch();
        const { assembleStyle, buildContextBlocks } = await import('../generator.js');
        const [style, blocks] = await Promise.all([
            assembleStyle(),
            // skipForbidden: explicit user targets must not be second-guessed
            // by the stop-words / forced-ignore lists.
            buildContextBlocks(messageId, swipeIdx, { skipForbidden: true }),
        ]);
        if (requestId !== _targetedState.requestId || !isEpochCurrent(epoch)) return;
        const result = await generateTargetedFootnotes({
            targets: _targetedState.input,
            messageId,
            swipeIdx,
            epoch,
            style,
            outputLanguage: S().outputLanguage === 'en' ? 'English' : 'Russian',
            context: blocks.join('\n\n'),
        });
        if (requestId !== _targetedState.requestId || !isEpochCurrent(epoch)) return;
        _targetedState.result = result.stale ? null : result;
        if (result.stale) {
            _targetedState.status = t('Request replaced');
            return;
        }
        if (!result.footnotes.length) {
            const parts = [parseNotice, t('Missing') + ': ' + result.targets.join(', ')].filter(Boolean);
            _targetedState.status = parts.join(' · ');
            return;
        }

        // Anchor + persist through the payload store (survives restarts).
        const rawMes = Array.isArray(message.swipes) ? (message.swipes[swipeIdx] ?? message.mes) : message.mes;
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
        const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (mesEl) {
            removeHighlights(mesEl);
            const merged = getVariantFootnotes(messageId, swipeIdx);
            if (merged?.length) injectHighlights(mesEl, merged);
        }
        playSound();
        panelInvalidate();
        const floating = toSave.filter(e => !e.prefix && !e.suffix).length;
        const parts = [];
        if (parseNotice) parts.push(parseNotice);
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
        if (requestId === _targetedState.requestId) {
            _targetedState.generating = false;
            _tabController?.refreshActiveTab();
        }
        panelInvalidate();
        updatePanel();
    }
}

function renderTargetedTab(body) {
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
    generate.textContent = t('Generate');
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
            toastr?.error?.(t('Copy failed'));
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
        const main = document.createElement('div');
        main.className = 'gls-panel-entry-main';
        const num = document.createElement('span');
        num.className = 'gls-panel-num gls-panel-num--targeted';
        num.textContent = indexToTargetedSymbol(fn.index);
        const txt = document.createElement('span');
        txt.className = 'gls-panel-text';
        txt.innerHTML = formatFootnoteText(fn.text);
        main.append(num, txt);
        row.append(main);
        wrap.appendChild(row);
    }
    body.appendChild(wrap);
    if (wasFocused) {
        input.focus();
        try { input.setSelectionRange(selStart, selEnd); } catch { /* detached */ }
    }
}

function renderExclusionsTab(body) {
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
        panelInvalidate();
        _tabController?.refreshActiveTab();
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
            list.appendChild(makePoolRow(anchor, key, {
                onDelete: () => deleteAnchorFromPool(key),
                onExclude: () => { togglePoolExcluded(anchor, true); _tabController?.refreshActiveTab(); },
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
            exclList.appendChild(makeExcludedPoolRow(anchor, {
                onRestore: () => { togglePoolExcluded(anchor, false); _tabController?.refreshActiveTab(); },
            }));
        }
        wrap.append(exclTitle, exclList);
    }

    return wrap;
}

/** One row in the active pool: anchor text + delete + exclude-from-pool buttons. */
function makePoolRow(anchor, key, { onDelete, onExclude }) {
    const row = document.createElement('div');
    row.className = 'gls-pool-item';
    const text = document.createElement('span');
    text.className = 'gls-pool-anchor';
    text.textContent = anchor;
    text.title = anchor;
    const actions = document.createElement('div');
    actions.className = 'gls-pool-item-actions';
    actions.append(
        makeRowButton('gls-panel-del', 'trash', t('Delete footnote'), onDelete),
        makeRowButton('gls-panel-copy', 'ban', t('Exclude from pool'), onExclude),
    );
    row.append(text, actions);
    return row;
}

/** One row in the excluded block: anchor text + restore button. */
function makeExcludedPoolRow(anchor, { onRestore }) {
    const row = document.createElement('div');
    row.className = 'gls-pool-item gls-pool-item--excluded';
    const text = document.createElement('span');
    text.className = 'gls-pool-anchor';
    text.textContent = anchor;
    text.title = anchor;
    const actions = document.createElement('div');
    actions.className = 'gls-pool-item-actions';
    actions.append(makeRowButton('gls-panel-copy', 'rotate-ccw', t('Restore'), onRestore));
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
    panelInvalidate();
    // Re-render each affected post's highlights (merged: regular + targeted).
    for (const msgId of affectedMsgIds) {
        const mesEl = document.querySelector(`.mes[mesid="${msgId}"]`);
        if (!mesEl) continue;
        removeHighlights(mesEl);
        const ctx = getCtx();
        const msg = ctx.chat?.[parseInt(msgId)];
        if (!msg) continue;
        const swipeIdx = msg.swipe_id ?? 0;
        const remaining = getVariantFootnotes(msgId, swipeIdx);
        if (remaining?.length) injectHighlights(mesEl, remaining);
    }
    _tabController?.refreshActiveTab();
}

// ══════════════════════════════════════════════════════════════════════════════
// LAYOUT PERSISTENCE (position / size of the panel, in localStorage)
// ══════════════════════════════════════════════════════════════════════════════

function loadPanelLayout() {
    try { return JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || 'null') || {}; } catch { return {}; }
}

function savePanelLayout(patch) {
    const cur = loadPanelLayout();
    try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify({ ...cur, ...patch })); } catch { /* quota */ }
}

function applyPanelLayout(panel) {
    const layout = loadPanelLayout();
    const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
    if (!isMobile && layout.left !== undefined && layout.top !== undefined) {
        panel.style.left = `${layout.left}px`;
        panel.style.top = `${layout.top}px`;
        panel.style.right = 'auto';
        panel.style.transform = 'none';
    }
    if (layout.width) panel.style.width = `${layout.width}px`;
    if (layout.height) panel.style.height = `${layout.height}px`;
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    let left = parseInt(panel.style.left) || rect.left;
    let top = parseInt(panel.style.top) || rect.top;
    left = Math.max(0, Math.min(left, window.innerWidth - 60));
    top = Math.max(0, Math.min(top, window.innerHeight - 60));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

// ══════════════════════════════════════════════════════════════════════════════
// MOBILE / VIEWPORT SYNC
// Ported from DS Comments (measureStChrome / initViewportSync). On a narrow
// viewport the panel becomes a fullscreen sheet inset between ST's top chrome
// (#top-bar) and the input bar (#send_form); drag/resize are disabled. A
// resize-listener toggles the mode live so rotating the device or narrowing the
// window reflows the panel instead of leaving it stuck in the desktop --side
// layout (the original bug: isMobile was computed only at buildPanel() time).
// ══════════════════════════════════════════════════════════════════════════════

const ST_TOPBAR_SEL = '#top-bar';
const ST_SENDFORM_SEL = '#send_form';
const ST_TOPBAR_FALLBACK = 40;   // px, only if #top-bar exists but reads ≤0
const ST_SENDFORM_FALLBACK = 120;

function isMobileViewport() {
    // Width check catches portrait phones + narrow desktop windows.
    if (window.innerWidth < MOBILE_BREAKPOINT) return true;
    // A phone rotated to landscape still has a small screen and a coarse
    // (touch) pointer — innerWidth alone misses it (a landscape phone can be
    // ≥768 CSS px wide). Detect via the short screen side + touch capability.
    // Tablets (short side ≥768) and touch laptops stay in desktop mode.
    const shortSide = Math.min(screen.width || 9999, screen.height || 9999);
    if (navigator.maxTouchPoints > 0 && shortSide < MOBILE_BREAKPOINT) return true;
    return false;
}

/**
 * Measure ST's top bar and input bar and expose them as CSS custom properties on
 * the panel, so the mobile fullscreen rule can inset between them instead of
 * being covered. Mirrors DS Comments measureStChrome(). Safe to call on desktop
 * (cheap) — the values are only read by the .gls-panel--mobile rule.
 */
function measureStChrome(panel) {
    let topH = 0;
    const topBar = document.querySelector(ST_TOPBAR_SEL);
    if (topBar) {
        const r = topBar.getBoundingClientRect();
        topH = r.bottom > 0 ? Math.min(r.bottom, window.innerHeight) : ST_TOPBAR_FALLBACK;
    }
    let bottomH = 0;
    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    if (sendForm) {
        const r = sendForm.getBoundingClientRect();
        bottomH = Math.max(0, Math.min(r.height, window.innerHeight)) || ST_SENDFORM_FALLBACK;
    }
    // Defensive caps: on some ST mobile layouts #send_form wraps more than the
    // input bar (or #top-bar is a tall container). Unbounded insets would make
    // height: calc(100dvh - top - bottom) go to 0 and hide the panel. The input
    // bar is never >50% of the viewport, the top bar never >40%.
    topH = Math.min(topH, Math.round(window.innerHeight * 0.4));
    bottomH = Math.min(bottomH, Math.round(window.innerHeight * 0.5));
    panel.style.setProperty('--gls-st-top', `${topH}px`);
    panel.style.setProperty('--gls-st-bottom', `${bottomH}px`);
}

/** Switch the panel to the fullscreen mobile sheet. Clears inline geometry so
 *  the CSS .gls-panel--mobile rules take over, then re-measures ST chrome. */
function applyMobileMode(panel) {
    panel.classList.add('gls-panel--mobile');
    panel.classList.remove('gls-panel--side');
    // Clear inline geometry so CSS fullscreen rules apply unimpeded.
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.transform = '';
    measureStChrome(panel);
}

/** Switch back to the desktop side panel: restore the persisted layout and
 *  clamp inside the viewport. */
function applyDesktopMode(panel) {
    panel.classList.remove('gls-panel--mobile');
    panel.classList.add('gls-panel--side');
    applyPanelLayout(panel);
    if (panel.style.left !== '' || panel.style.top !== '') clampPanel(panel);
}

let _viewportBound = false;
let _viewportTimer = null;
let _viewportHandler = null;
let _chromeResizeObserver = null;
// Disposer for the pending APP_READY subscription (when #send_form wasn't
// mounted yet at attach time) — disconnectViewportSync MUST invoke it, or a
// disable before APP_READY lets the late event attach an orphaned observer.
let _viewportReadyDispose = null;

/**
 * Bind a debounced resize listener that toggles the panel between desktop and
 * mobile fullscreen layouts. Idempotent. Also watches #send_form with a
 * ResizeObserver so the mobile bottom inset tracks QR-bar expand/collapse.
 * Call disconnectViewportSync() from cleanup().
 */
export function initViewportSync() {
    if (_viewportBound) return;
    _viewportBound = true;
    _viewportHandler = () => {
        if (_viewportTimer) return;
        _viewportTimer = setTimeout(() => {
            _viewportTimer = null;
            const panel = _floatingPanel;
            if (!panel || panel.style.display === 'none') return;
            if (isMobileViewport()) {
                applyMobileMode(panel);
            } else {
                applyDesktopMode(panel);
            }
        }, 200);
    };
    window.addEventListener('resize', _viewportHandler);
    // #send_form's height changes at runtime (QR panel expand/collapse, extension
    // toolbar). Track it so the mobile bottom inset stays correct without a
    // window resize. #send_form is lazy-mounted by ST: when it isn't in the DOM
    // yet, wait on APP_READY (whenSendFormReady — event-driven, no deadline)
    // instead of a setInterval probe. The disposer is module-owned so
    // disconnectViewportSync can cancel the pending subscription.
    if (typeof ResizeObserver !== 'undefined') {
        const attachChromeObserver = (sendForm) => {
            _chromeResizeObserver = new ResizeObserver(() => {
                if (_floatingPanel && isMobileViewport()) measureStChrome(_floatingPanel);
            });
            _chromeResizeObserver.observe(sendForm);
        };
        const sendForm = document.querySelector(ST_SENDFORM_SEL);
        if (sendForm) {
            attachChromeObserver(sendForm);
        } else {
            _viewportReadyDispose = whenSendFormReady(attachChromeObserver, {
                onGiveUp: () => { _viewportReadyDispose = null; },
            });
        }
    }
}

export function disconnectViewportSync() {
    if (_viewportTimer) { clearTimeout(_viewportTimer); _viewportTimer = null; }
    if (_viewportBound && _viewportHandler) {
        window.removeEventListener('resize', _viewportHandler);
        _viewportHandler = null;
    }
    _viewportBound = false;
    if (_chromeResizeObserver) { _chromeResizeObserver.disconnect(); _chromeResizeObserver = null; }
    if (_viewportReadyDispose) { _viewportReadyDispose(); _viewportReadyDispose = null; }
}

/**
 * rAF-coalesced drag. Style writes are batched into a single
 * requestAnimationFrame per pointer-event burst, so the browser paints the
 * panel at most once per frame instead of once per mousemove (which caused
 * layout-thrash on the original implementation). Touch + mouse share one path.
 *
 * The dead zone (4px) and clamp behaviour are preserved, and the pending frame
 * is flushed synchronously on pointerup so the panel lands exactly at the
 * release point.
 *
 * On teardown, destroyPanel() calls _abortDragResize() so an in-flight drag
 * does not leave mousemove/mouseup listeners on document.
 */
let _abortDragResize = null;

function makeDraggable(panel, handle, enabledWhen) {
    let startX, startY, startLeft, startTop, isDragging = false, hasMoved = false;
    let pendingFrame = 0;
    let nextLeft = 0, nextTop = 0;

    const flush = () => {
        pendingFrame = 0;
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
    };

    const onDown = (e) => {
        if (isMobileViewport()) return;
        if (enabledWhen && !enabledWhen()) return;
        if (e.target.closest('button, .gls-panel-btn, .gls-panel-nav-btn')) return;
        isDragging = true; hasMoved = false;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const rect = panel.getBoundingClientRect();
        startX = clientX; startY = clientY;
        startLeft = rect.left; startTop = rect.top;
        nextLeft = startLeft; nextTop = startTop;
        panel.style.willChange = 'left, top';
        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        // The OS can cancel the gesture mid-drag (edge swipe, notification
        // shade) — without this the drag stays "in flight" and the document
        // listeners leak until the next touch anywhere.
        document.addEventListener('touchcancel', onUp);
    };

    const onMove = (e) => {
        if (!isDragging) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        const dx = cx - startX, dy = cy - startY;
        // Dead zone so a click on the header (without drag) doesn't move the panel.
        if (!hasMoved && Math.hypot(dx, dy) < 4) return;
        hasMoved = true;
        e.preventDefault();
        if (!panel.style.left || panel.style.left === 'auto') {
            panel.style.left = `${startLeft}px`;
            panel.style.top = `${startTop}px`;
            panel.style.right = 'auto';
            panel.style.transform = 'none';
        }
        nextLeft = startLeft + dx;
        nextTop = startTop + dy;
        // Coalesce: at most one style write per frame.
        if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
    };

    const onUp = (e) => {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        // Flush any pending frame synchronously so the panel lands at the
        // exact release point, then clear the will-change hint.
        if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        flush();
        panel.style.willChange = '';
        if (!hasMoved) return;
        e.stopPropagation?.();
        clampPanel(panel);
        savePanelLayout({ left: parseInt(panel.style.left), top: parseInt(panel.style.top) });
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });

    // Allow destroyPanel() to release an in-flight drag without a real pointer
    // event. onUp is no-op when !isDragging, so this is safe to call anytime.
    _abortDragResize = (syntheticEvent) => {
        if (isDragging) onUp(syntheticEvent);
        else if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    };
}

/**
 * rAF-coalesced resize via a bottom-right grip. Width/height are persisted
 * (debounced) into PANEL_LAYOUT_KEY. Same one-write-per-frame pattern as drag.
 * Disabled on mobile (the panel is a bottom-sheet there) and when collapsed.
 */
function makeResizable(panel) {
    const grip = document.createElement('div');
    grip.className = 'gls-panel-resize';
    grip.title = t('Resize');
    panel.appendChild(grip);

    let isResizing = false, startX, startY, startW, startH;
    let pendingFrame = 0, nextW = 0, nextH = 0, saveTimer = null;

    const flush = () => {
        pendingFrame = 0;
        panel.style.width = `${nextW}px`;
        panel.style.height = `${nextH}px`;
    };

    const onMove = (e) => {
        if (!isResizing) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        nextW = Math.max(220, startW + (cx - startX));
        nextH = Math.max(120, startH + (cy - startY));
        e.preventDefault();
        if (!pendingFrame) pendingFrame = requestAnimationFrame(flush);
    };

    const onUp = () => {
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        document.removeEventListener('touchcancel', onUp);
        if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        flush();
        panel.style.willChange = '';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            savePanelLayout({ width: panel.offsetWidth, height: panel.offsetHeight });
        }, 300);
    };

    const onDown = (e) => {
        if (isMobileViewport()) return;
        isResizing = true;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        startX = cx; startY = cy;
        const rect = panel.getBoundingClientRect();
        startW = rect.width; startH = rect.height;
        nextW = startW; nextH = startH;
        panel.style.willChange = 'width, height';
        document.addEventListener('mousemove', onMove, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);
        // See makeDraggable: a cancelled gesture must release the resize.
        document.addEventListener('touchcancel', onUp);
        e.preventDefault();
        e.stopPropagation();
    };

    grip.addEventListener('mousedown', onDown);
    grip.addEventListener('touchstart', onDown, { passive: false });

    // Layered onto _abortDragResize: abort resize too, plus clear the save
    // debounce timer. destroyPanel() clears _abortDragResize after invoking it.
    const prevAbort = _abortDragResize;
    _abortDragResize = (syntheticEvent) => {
        if (isResizing) onUp(syntheticEvent);
        else if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        prevAbort?.(syntheticEvent);
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// PANEL MOUNT / VISIBILITY
// ══════════════════════════════════════════════════════════════════════════════

/** Idempotent mount. Returns the #gls-panel element (or null on failure). */
export function buildPanel() {
    if (_floatingPanel) return _floatingPanel;
    const isMobile = isMobileViewport();
    const panel = document.createElement('div');
    panel.id = 'gls-panel';
    panel.className = 'gls-panel ' + (isMobile ? 'gls-panel--mobile' : 'gls-panel--side');

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'gls-panel-header';

    const nav = document.createElement('div');
    nav.className = 'gls-panel-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'gls-panel-nav-btn';
    prevBtn.innerHTML = iconHtml('chevron-left');
    prevBtn.title = t('Previous');
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigatePanel(-1); });

    const navLabel = document.createElement('div');
    navLabel.className = 'gls-panel-nav-label';
    navLabel.id = 'gls-panel-nav-label';
    navLabel.textContent = t('Footnotes');

    const nextBtn = document.createElement('button');
    nextBtn.className = 'gls-panel-nav-btn';
    nextBtn.innerHTML = iconHtml('chevron-right');
    nextBtn.title = t('Next');
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigatePanel(1); });

    nav.appendChild(prevBtn);
    nav.appendChild(navLabel);
    nav.appendChild(nextBtn);

    const controls = document.createElement('div');
    controls.className = 'gls-panel-controls';

    const clearMsgBtn = document.createElement('div');
    clearMsgBtn.className = 'gls-panel-btn gls-panel-btn--clear';
    clearMsgBtn.title = t('Clear message footnotes');
    clearMsgBtn.innerHTML = iconHtml('trash');
    clearMsgBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await showConfirmModal(t('Delete message footnotes'))) return;
        const currentMsgId = state.panelFocusMsgId;
        if (!currentMsgId) return;
        // Clear the SHOWN variant only — other variants' footnotes remain
        // valid for their own texts (they live in their own swipe slots).
        const msg = getCtx().chat?.[parseInt(currentMsgId)];
        const swipeIdx = msg?.swipe_id ?? 0;
        clearVariant(currentMsgId, swipeIdx);
        panelInvalidate();
        const mesEl = document.querySelector(`.mes[mesid="${currentMsgId}"]`);
        if (mesEl) removeHighlights(mesEl);
        const body = document.getElementById('gls-panel-body');
        if (body) body.innerHTML = '';
        renderPanel(currentMsgId);
    });

    const closeBtn = document.createElement('div');
    closeBtn.className = 'gls-panel-btn';
    closeBtn.title = t('Close');
    closeBtn.innerHTML = iconHtml('xmark');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // '✕' hides the window but ALSO persists the choice (floatingPanelHidden)
        // so it stays hidden across page reloads / server restarts. The launcher
        // click re-shows (and clears the flag); a SECOND launcher click while
        // visible is what toggles the panel off permanently. Updating the
        // launcher's active state here so it visually de-emphasises (panel not
        // visibly active = launcher isn't lit).
        if (_floatingPanel) _floatingPanel.style.display = 'none';
        S().floatingPanelHidden = true;
        saveSettings();
        import('./launcher.js').then(({ ensureLauncher }) => ensureLauncher()).catch(() => {});
    });

    // No regenerate button here: the header regen duplicated the per-message
    // .gls-regen-btn (renderer.js addRegenButton), which is present on every
    // message the panel can focus, shows the same busy spin (setSpinner), and
    // lives right next to the text being regenerated. Removed in v3.2.

    controls.appendChild(clearMsgBtn);
    controls.appendChild(closeBtn);
    header.appendChild(nav);
    header.appendChild(controls);

    const body = document.createElement('div');
    body.className = 'gls-panel-body';
    body.id = 'gls-panel-body';
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', 'gls-tab-footnotes');

    panel.appendChild(header);

    const tabs = document.createElement('div');
    tabs.className = 'gls-panel-tabs';
    panel.appendChild(tabs);
    panel.appendChild(body);

    _tabController = createTabController({
        getPersistedTab: () => S().activePanelTab,
        persistTab: id => { S().activePanelTab = id; saveSettings(); },
        onChange: tab => {
            body.setAttribute('aria-labelledby', `gls-tab-${tab.id}`);
            // A non-footnotes tab render overwrites the body, so the footnotes
            // render-key cache (which gates renderFootnotesTab's early-return)
            // would go stale: switching back to Footnotes would then short-
            // circuit and leave the other tab's content visible (e.g. Targeted's
            // textarea after a Generate). Drop the key whenever the body is
            // about to be replaced by a non-footnotes render.
            if (tab.id !== 'footnotes') panelInvalidate();
            tab.render(body);
        },
        getScrollTop: () => body.scrollTop,
        setScrollTop: value => { body.scrollTop = value; },
    });
    _tabController.registerTab({ id: 'footnotes', label: t('Footnotes'), render: () => renderFootnotesTab(state.panelFocusMsgId) });
    _tabController.registerTab({ id: 'targeted', label: t('Targeted'), render: () => renderTargetedTab(body) });
    _tabController.registerTab({ id: 'exclusions', label: t('Exclusions'), render: () => renderExclusionsTab(body) });
    _tabController.renderTabButtons(tabs, { panelId: body.id });
    // First mount after enable: load this chat's persisted targets draft into
    // the tab state (chat switches go through clearTargetedTabState instead).
    clearTargetedTabState();
    _tabController.refreshActiveTab();
    
    document.body.appendChild(panel);
    _floatingPanel = panel;

    if (isMobile) {
        measureStChrome(panel);
    } else {
        applyPanelLayout(panel);
    }
    // Always attach drag/resize (buildPanel is idempotent -> runs once per panel).
    // On mobile the isMobileViewport() guard in each onDown no-ops them; on a
    // mobile->desktop transition the listeners are already in place, so the panel
    // is immediately draggable/resizable without a disable+re-enable cycle (N1).
    makeDraggable(panel, header);
    makeResizable(panel);

    renderPanel(state.panelFocusMsgId);
    return _floatingPanel;
}

export function destroyPanel() {
    // Abort any in-flight drag/resize so document listeners don't outlive the
    // panel (a disable mid-gesture previously leaked mousemove/mouseup).
    if (_abortDragResize) {
        try { _abortDragResize({}); } catch { /* non-critical */ }
        _abortDragResize = null;
    }
    if (_floatingPanel) {
        _floatingPanel.removeAttribute('data-render-key');
        _floatingPanel.remove();
        _floatingPanel = null;
    }
    _tabController = null;
}

export function clearTargetedTabState() {
    // Drop a pending draft persist first: its 400ms callback reads
    // _targetedState.input at fire time, which by then already holds the NEW
    // chat's draft — saving it would clobber the freshly loaded draft with a
    // tail of the old one (and the timer must not outlive cleanup either).
    if (_draftSaveTimer) { clearTimeout(_draftSaveTimer); _draftSaveTimer = null; }
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

/** Force the next renderPanel() to rebuild the body even if the key matches. */
export function panelInvalidate() {
    _floatingPanel?.removeAttribute('data-render-key');
}

export function getPanel() {
    return _floatingPanel;
}

/** §6.3: panel-is-visible predicate — mounted AND display !== 'none'. Used by
 *  the launcher click decision (toggle off vs. un-hide) and for the launcher's
 *  active-state class (so a ✕-hidden-but-enabled panel is not lit). */
export function panelIsVisible() {
    return !!_floatingPanel && _floatingPanel.style.display !== 'none';
}

export function isInChat() {
    const ctx = getCtx();
    return ctx.characterId !== undefined || ctx.groupId !== undefined;
}

/**
 * Reconcile panel existence + visibility with settings. Called whenever the
 * panel-enabled flag or chat state may have changed.
 *
 * Visibility follows the persisted floatingPanelHidden flag — the user's ✕/show
 * choice is the single source of truth and survives reloads. Out-of-chat still
 * force-hides for the session, but re-entering a chat restores the persisted
 * choice (a user who never ✕-hid the panel gets it back on the next chat,
 * instead of it staying dark until a launcher click).
 */
export function updatePanel() {
    if (!S().floatingPanelEnabled) {
        if (_floatingPanel) destroyPanel();
        return;
    }
    if (!_floatingPanel) buildPanel();
    if (!isInChat()) { _floatingPanel.style.display = 'none'; return; }
    if (S().floatingPanelHidden) { _floatingPanel.style.display = 'none'; return; }
    _floatingPanel.style.display = '';
    renderPanel(state.panelFocusMsgId);
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE LIST + RENDER
// ══════════════════════════════════════════════════════════════════════════════

export function invalidateAiMsgCache() {
    state.cachedAnnotatableMsgIds = null;
}

// "Annotatable" = AI messages, OR (when S().glossUserMessages is on) user
// messages too. System messages are never annotatable. The memoized list is
// invalidated on chat switch / edit / delete via invalidateAiMsgCache().
function getAllAnnotatableMsgIds() {
    if (state.cachedAnnotatableMsgIds) return state.cachedAnnotatableMsgIds;
    const ctx = getCtx();
    if (!ctx.chat) return [];
    const allowUser = S().glossUserMessages;
    state.cachedAnnotatableMsgIds = ctx.chat
        .map((msg, i) => ({ msg, i }))
        .filter(({ msg }) => msg && !msg.is_system && (allowUser ? true : !msg.is_user))
        .map(({ i }) => String(i));
    return state.cachedAnnotatableMsgIds;
}

/**
 * Render the panel body for a given (or focused) message. Skips re-render when
 * the data-render-key already matches — call panelInvalidate() to force.
 */
export function renderPanel(msgId, swipeIdxHint) {
    if (_tabController && _tabController.getActiveTab() !== 'footnotes') {
        _tabController.refreshActiveTab();
        return;
    }
    renderFootnotesTab(msgId, swipeIdxHint);
}

function renderFootnotesTab(msgId, swipeIdxHint) {
    if (!_floatingPanel) return;
    const body = document.getElementById('gls-panel-body');
    const navLabel = document.getElementById('gls-panel-nav-label');
    if (!body) return;

    const ctx = getCtx();
    const annotatableIds = getAllAnnotatableMsgIds();
    if (!annotatableIds.length) {
        if (navLabel) navLabel.textContent = t('Footnotes');
        body.innerHTML = `<div class="gls-empty gls-empty--state">${renderEmptyStateHTML('no-ai')}</div>`;
        return;
    }

    if (msgId !== null && msgId !== undefined && annotatableIds.includes(String(msgId))) {
        state.panelFocusMsgId = String(msgId);
    } else if (!state.panelFocusMsgId || !annotatableIds.includes(state.panelFocusMsgId)) {
        state.panelFocusMsgId = annotatableIds[annotatableIds.length - 1];
    }

    const focusId = state.panelFocusMsgId;
    const msg = ctx.chat?.[parseInt(focusId)];
    const swipeIdx = swipeIdxHint !== undefined ? swipeIdxHint : (msg?.swipe_id ?? 0);
    const swipeCount = Array.isArray(msg?.swipes) ? msg.swipes.length : 1;
    const name = msg?.name || t('Message');

    if (navLabel) {
        const swipePart = swipeCount > 1 ? ` · ${swipeIdx + 1}/${swipeCount}` : '';
        navLabel.textContent = `${name}${swipePart}`;
        navLabel.title = navLabel.textContent;
    }

    const focusIdx = annotatableIds.indexOf(focusId);
    const prevBtn = _floatingPanel.querySelector('.gls-panel-nav-btn:first-of-type');
    const nextBtn = _floatingPanel.querySelector('.gls-panel-nav-btn:last-of-type');
    if (prevBtn) prevBtn.disabled = focusIdx <= 0;
    if (nextBtn) nextBtn.disabled = focusIdx >= annotatableIds.length - 1;
    // Generation busy state is shown by the per-message .gls-regen-btn
    // (setSpinner in renderer.js); the panel itself has no regen control.

    const payload = getVariantPayload(focusId, swipeIdx);
    const digest = payload?.contentDigest ?? digestFor(focusId, swipeIdx) ?? '';
    const targeted = targetedOf(payload);
    // generatedAt + targeted length participate in the key: targeted saves
    // don't change the digest (text unchanged), so without them a targeted
    // commit would leave the Footnotes tab showing a stale list.
    const cacheKey = `footnotes:${focusId}:${swipeIdx}:${digest || 'none'}:${payload?.generatedAt ?? 0}:${targeted.length}`;
    if (_floatingPanel.dataset.renderKey === cacheKey && swipeIdxHint === undefined) return;
    _floatingPanel.dataset.renderKey = cacheKey;
    body.innerHTML = '';

    // Merged view: regular (tagged fn) then targeted (tagged t).
    const footnotes = payload
        ? [...payload.footnotes.map(f => ({ ...f, kind: 'fn' })), ...targeted.map(e => ({ ...e, kind: 't' }))]
        : null;

    if (!footnotes?.length) {
        // A payload with only orphans (everything died in an edit/continue
        // rebind) shows the loss banner instead of the generic empty state —
        // the user should know footnotes existed and can regenerate.
        if (payload && (payload.orphans?.length || (payload.footnotes?.length === 0 && targeted.length === 0))) {
            body.appendChild(makeOrphanBanner(payload.orphans?.length ?? 0, focusId, swipeIdx));
            return;
        }
        // Centralized empty-state via empty.js (disabled / unconfigured /
        // generating / empty+CTA).
        const msg2 = ctx.chat?.[parseInt(focusId)];
        const isAnnotatable = msg2 && !msg2.is_system && (S().glossUserMessages ? true : !msg2.is_user);
        let reason;
        // §6.4: !state.configuredState.ok wins over everything else so a
        // persistent "Source not configured" badge stays until a successful
        // generation flips configuredState back to ok.
        if (!state.configuredState.ok) reason = 'unconfigured';
        else if (state.isGenerating[focusId]) reason = 'generating';
        else if (!isAnnotatable) reason = 'empty';   // system message -> neutral, no CTA
        else reason = detectEmptyReason({
            enabled: true,
            generating: false,
            configured: state.configuredState,
        });
        const empty = document.createElement('div');
        empty.className = 'gls-empty gls-empty--state';
        empty.innerHTML = renderEmptyStateHTML(reason, {
            isAnnotatable,
            // Pass the configured-state reason through to the 'unconfigured'
            // branch so the badge shows the cause. Ignored for other reasons.
            reason: state.configuredState.ok ? '' : state.configuredState.reason,
        });

        // Wire the Generate CTA (only present in the 'empty' + annotatable case).
        const cta = empty.querySelector('.gls-empty-generate');
        if (cta) {
            cta.addEventListener('click', async () => {
                const { generateFootnotes } = await import('../generator.js');
                const ctx3 = getCtx();
                const m = ctx3.chat?.[parseInt(focusId)];
                const swipe = m?.swipe_id ?? 0;
                const mesEl = document.querySelector(`.mes[mesid="${focusId}"]`);
                if (mesEl) await generateFootnotes(focusId, swipe, mesEl);
            });
        }

        // §6.4: wire the "Open settings" CTA — expands the Generation Engine
        // accordion in the Extensions panel and scrolls it into view.
        const configureCta = empty.querySelector('.gls-empty-configure');
        if (configureCta) {
            configureCta.addEventListener('click', () => {
                const container = document.getElementById('gls_settings_container');
                if (!container) return;
                const header = container.querySelector('.gls-s-section-header');
                if (header) {
                    const body2 = header.nextElementSibling;
                    if (body2?.hidden) header.click();
                    header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        }

        body.appendChild(empty);
        return;
    }

    // Partial loss: survivors listed below, orphans flagged above them.
    if (payload?.orphans?.length) {
        body.appendChild(makeOrphanBanner(payload.orphans.length, focusId, swipeIdx));
    }

    for (const fn of footnotes) {
        const isTargeted = fn.kind === 't';
        const row = document.createElement('div');
        row.className = 'gls-panel-entry';

        // Content row: mono index (accent) + body text. The text loses its
        // leading superscript via stripLeadingNumber so the index isn't shown
        // twice — the panel owns the number, the text owns the prose.
        // Targeted entries show their typographic symbol instead and carry no
        // numeric prefix at all; a floating one (target not present in the
        // post text) gets a badge since it has no marker in the chat.
        const main = document.createElement('div');
        main.className = 'gls-panel-entry-main';

        const num = document.createElement('span');
        num.className = 'gls-panel-num' + (isTargeted ? ' gls-panel-num--targeted' : '');
        num.textContent = isTargeted ? indexToTargetedSymbol(fn.index) : fn.index;

        const txtEl = document.createElement('span');
        txtEl.className = 'gls-panel-text';
        txtEl.innerHTML = formatFootnoteText(isTargeted ? fn.text : stripLeadingNumber(fn.text));

        main.append(num, txtEl);
        if (isTargeted && !fn.prefix && !fn.suffix) {
            const badge = document.createElement('span');
            badge.className = 'gls-panel-floating-badge';
            badge.textContent = t('not anchored');
            main.appendChild(badge);
        }

        // Action bar — always visible, icon + label. Copy gives inline
        // "Copied ✓" feedback for 1.5s instead of a global toast, which is
        // clearer when several footnotes share the viewport.
        const actions = document.createElement('div');
        actions.className = 'gls-panel-entry-actions';

        const reRender = () => { panelInvalidate(); renderPanel(focusId, swipeIdx); };
        const buttons = buildFootnoteActions({
            fn, msgId: focusId, swipeIdx, digest,
            kind: isTargeted ? 't' : 'fn',
            variant: 'panel',
            editHost: row,
            // The panel is the focus owner; an edit is valid only while this
            // message is still focused (mirrors the pre-refactor guard).
            validateContext: () => String(state.panelFocusMsgId) === String(focusId),
            // The panel is the presenter for highlight refresh: after a delete
            // it re-injects the merged (possibly renumbered) survivors — read
            // fresh from the store so both kinds survive — or strips
            // highlights when the payload was emptied.
            onRefreshHighlights: (_footnotes, msgId) => {
                const mesEl = document.querySelector(`.mes[mesid="${msgId}"]`);
                if (!mesEl) return;
                removeHighlights(mesEl);
                const swipe = getCtx().chat?.[parseInt(msgId)]?.swipe_id ?? 0;
                const merged = getVariantFootnotes(msgId, swipe);
                if (merged?.length) injectHighlights(mesEl, merged);
            },
            onAfterEdit: reRender,
            onAfterDelete: () => { panelInvalidate(); renderPanel(focusId); },
        });
        actions.append(buttons.copy, buttons.edit, buttons.del);
        row.append(main, actions);
        body.appendChild(row);
    }
}

/**
 * "Anchors lost" banner: shown when a rebind (edit / continue) orphaned some
 * or all of a variant's footnote anchors. Regenerating is the user's explicit
 * choice — rebind never spends an API call on its own.
 */
function makeOrphanBanner(count, focusId, swipeIdx) {
    const banner = document.createElement('div');
    banner.className = 'gls-orphan-banner';
    const label = document.createElement('span');
    label.className = 'gls-orphan-label';
    label.textContent = t('{0} anchor(s) lost after the post was edited', count);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gls-orphan-regen';
    btn.textContent = t('Regenerate');
    btn.addEventListener('click', async () => {
        const { generateFootnotes } = await import('../generator.js');
        const mesEl = document.querySelector(`.mes[mesid="${focusId}"]`);
        renderPanel(focusId);   // busy state kicks in immediately
        await generateFootnotes(focusId, swipeIdx, mesEl);
    });
    banner.append(label, btn);
    return banner;
}

function makeActionButton(cls, icon, label, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.title = label;
    btn.innerHTML = `${iconHtml(icon, { size: 12 })}<span>${label}</span>`;
    btn.addEventListener('click', handler);
    return btn;
}

// Alias kept for the trash-tab / pool-tab callers (delete-footnote,
// exclude-from-pool, restore) — they predate the shared action module and use
// the original name. The footnote Copy/Edit/Delete rows go through
// buildFootnoteActions; only these auxiliary buttons stay local.
const makeRowButton = makeActionButton;

function navigatePanel(dir) {
    const ids = getAllAnnotatableMsgIds();
    if (!ids.length) return;
    const curIdx = ids.indexOf(state.panelFocusMsgId ?? '');
    const nextIdx = curIdx + dir;
    if (nextIdx < 0 || nextIdx >= ids.length) return;
    state.panelFocusMsgId = ids[nextIdx];
    renderPanel(state.panelFocusMsgId);
    const mesEl = document.querySelector(`.mes[mesid="${state.panelFocusMsgId}"]`);
    mesEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** Scroll-observer hook: switch the focused message when the user scrolls. */
export function setVisiblePost(msgId) {
    if (!S().floatingPanelEnabled || state.panelFocusMsgId === String(msgId)) return;
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(msgId)];
    if (!msg || msg.is_system) return;
    // User posts become focusable by the scroll-observer only when
    // glossUserMessages is on (mirrors getAllAnnotatableMsgIds).
    if (msg.is_user && !S().glossUserMessages) return;
    state.panelFocusMsgId = String(msgId);
    renderPanel(msgId, msg.swipe_id ?? 0);
}
