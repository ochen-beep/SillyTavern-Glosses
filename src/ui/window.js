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
    state, S, getCtx, saveSettings, showConfirmModal, t,
} from '../core.js';
import { getVariantPayload, digestFor, clearVariant } from '../cache.js';
import { targetedOf } from '../domain/footnote-payload.js';
import { isAnnotatableMsg } from '../domain/message-identity.js';
import { removeHighlights, reinjectInto } from '../renderer.js';
import { createTabController } from './tabs.js';
import { iconHtml } from './icons.js';
import { renderEmptyStateHTML } from './empty.js';
import { buildFootnoteActions } from './footnote-actions.js';
import {
    makeEntryMain, renderTargetedTab, clearTargetedTabState, initTargetedTabDeps,
} from './panel-targeted-tab.js';
import { renderExclusionsTab, initExclusionsTabDeps } from './panel-exclusions-tab.js';
import {
    makeDraggable, makeResizable, abortDragResize, applyPanelLayout,
    isMobileViewport, measureStChrome, applyMobileMode, applyDesktopMode,
} from './panel-layout.js';

let _floatingPanel = null;
let _tabController = null;







// ══════════════════════════════════════════════════════════════════════════════
// PANEL MOUNT / VISIBILITY
// ══════════════════════════════════════════════════════════════════════════════

/** Click-on-Enter/Space for the header's div-buttons. The header controls are
 *  divs (styled via .gls-panel-btn; real <button> chrome fights the styling),
 *  so without this they are pointer-only — a11y fix alongside role="button". */
function wireKeyboardActivation(el) {
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        el.click();
    });
}

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

    // Explicit "jump to the focused post" — the only chat-scrolling control,
    // now that the nav arrows leave the chat alone. Flash the post so the eye
    // catches where the panel's content lives.
    const jumpBtn = document.createElement('div');
    jumpBtn.className = 'gls-panel-btn gls-panel-btn--jump';
    jumpBtn.title = t('Jump to the post');
    jumpBtn.setAttribute('role', 'button');
    jumpBtn.setAttribute('tabindex', '0');
    jumpBtn.setAttribute('aria-label', t('Jump to the post'));
    jumpBtn.innerHTML = iconHtml('crosshair');
    wireKeyboardActivation(jumpBtn);
    jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const focusId = state.panelFocusMsgId;
        if (focusId === null || focusId === undefined) return;
        const mesEl = document.querySelector(`.mes[mesid="${focusId}"]`);
        // Chat truncation: the post can exist in ctx.chat but not in the DOM
        // (older than the loaded window) — say so instead of failing silently.
        if (!mesEl) {
            globalThis.toastr?.info?.(t('Post is not loaded in chat'));
            return;
        }
        mesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mesEl.classList.remove('gls-mes-flash');
        void mesEl.offsetWidth; // reflow restarts the animation on repeated clicks
        mesEl.classList.add('gls-mes-flash');
        mesEl.addEventListener('animationend', () => mesEl.classList.remove('gls-mes-flash'), { once: true });
    });

    const clearMsgBtn = document.createElement('div');
    clearMsgBtn.className = 'gls-panel-btn gls-panel-btn--clear';
    clearMsgBtn.title = t('Clear message footnotes');
    clearMsgBtn.setAttribute('role', 'button');
    clearMsgBtn.setAttribute('tabindex', '0');
    clearMsgBtn.setAttribute('aria-label', t('Clear message footnotes'));
    wireKeyboardActivation(clearMsgBtn);
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
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('tabindex', '0');
    closeBtn.setAttribute('aria-label', t('Close'));
    wireKeyboardActivation(closeBtn);
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

    controls.appendChild(jumpBtn);
    controls.appendChild(clearMsgBtn);
    controls.appendChild(closeBtn);
    header.appendChild(nav);
    header.appendChild(controls);

    const body = document.createElement('div');
    body.className = 'gls-panel-body';
    body.id = 'gls-panel-body';
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', 'gls-tab-footnotes');
    // Compact rows: one delegated toggle for every row this body will ever
    // host (rows are rebuilt on each render). Only the text area toggles —
    // the action buttons live outside .gls-panel-entry-main.
    body.addEventListener('click', (e) => {
        if (!S().panelCompactRows) return;
        const main = e.target.closest?.('.gls-panel-entry-main');
        if (main && body.contains(main)) {
            main.closest('.gls-panel-entry')?.classList.toggle('gls-panel-entry--expanded');
        }
    });

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
    _tabController.registerTab({ id: 'footnotes', label: t('Footnotes'), labelKey: 'Footnotes', render: () => renderFootnotesTab(state.panelFocusMsgId) });
    _tabController.registerTab({ id: 'targeted', label: t('Targeted'), labelKey: 'Targeted', render: () => renderTargetedTab(body) });
    _tabController.registerTab({ id: 'exclusions', label: t('Exclusions'), labelKey: 'Exclusions', render: () => renderExclusionsTab(body) });
    initTargetedTabDeps({ panelInvalidate, updatePanel, getTabController: () => _tabController });
    initExclusionsTabDeps({ panelInvalidate, getTabController: () => _tabController });
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
    try { abortDragResize({}); } catch { /* non-critical */ }
    if (_floatingPanel) {
        _floatingPanel.removeAttribute('data-render-key');
        _floatingPanel.remove();
        _floatingPanel = null;
    }
    _tabController = null;
}


/** Force the next renderPanel() to rebuild the body even if the key matches. */
export function panelInvalidate() {
    _floatingPanel?.removeAttribute('data-render-key');
}

/** §6.3: panel-is-visible predicate — mounted AND display !== 'none'. Used by
 *  the launcher click decision (toggle off vs. un-hide) and for the launcher's
 *  active-state class (so a ✕-hidden-but-enabled panel is not lit). */
export function panelIsVisible() {
    return !!_floatingPanel && _floatingPanel.style.display !== 'none';
}

function isInChat() {
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
        syncFabPassthrough();
        return;
    }
    if (!_floatingPanel) buildPanel();
    if (!isInChat()) { _floatingPanel.style.display = 'none'; syncFabPassthrough(); return; }
    if (S().floatingPanelHidden) { _floatingPanel.style.display = 'none'; syncFabPassthrough(); return; }
    _floatingPanel.style.display = '';
    // Re-evaluate the mobile/desktop layout on every show: the resize handler
    // skips a hidden panel, so rotating/narrowing while it was ✕-hidden would
    // otherwise leave it in the stale mode until the next window resize.
    if (isMobileViewport()) applyMobileMode(_floatingPanel);
    else applyDesktopMode(_floatingPanel);
    renderPanel(state.panelFocusMsgId);
    syncFabPassthrough();
}

/**
 * UX: the FAB paints above the panel (z-order 2999 vs 2998 — contract-locked in
 * tests/floating-launcher.test.mjs, the FAB must stay clickable over the
 * fullscreen mobile sheet). A FAB *parked* over the panel's HEADER therefore
 * swallows taps meant for Prev/Next/Jump/Clear/✕. floating-launcher resolves
 * the conflict by making the FAB click-transparent while it overlaps the
 * header of a visible panel; this module only reports visibility changes.
 * Dynamic import — floating-launcher statically imports this module, so a
 * static back-import would close a cycle (same pattern as launcher.js).
 * Exported (F5): panel-layout calls this via its own dynamic import instead
 * of keeping a twin helper.
 */
export function syncFabPassthrough() {
    import('./floating-launcher.js')
        .then(({ syncFloatingLauncher }) => syncFloatingLauncher())
        .catch(() => { /* best-effort UI nicety */ });
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
export function renderPanel(msgId) {
    if (_tabController && _tabController.getActiveTab() !== 'footnotes') {
        _tabController.refreshActiveTab();
        return;
    }
    renderFootnotesTab(msgId);
}

function renderFootnotesTab(msgId) {
    if (!_floatingPanel) return;
    const body = document.getElementById('gls-panel-body');
    const navLabel = document.getElementById('gls-panel-nav-label');
    if (!body) return;
    body.classList.toggle('gls-panel--compact', S().panelCompactRows === true);

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
    const swipeIdx = msg?.swipe_id ?? 0;
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
    if (_floatingPanel.dataset.renderKey === cacheKey) return;
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
        const isAnnotatable = isAnnotatableMsg(ctx.chat?.[parseInt(focusId)]);
        let reason;
        // §6.4: !state.configuredState.ok wins over everything else so a
        // persistent "Source not configured" badge stays until a successful
        // generation flips configuredState back to ok.
        if (!state.configuredState.ok) reason = 'unconfigured';
        else if (state.isGenerating[focusId]) reason = 'generating';
        else if (!isAnnotatable) reason = 'empty';   // system message -> neutral, no CTA
        else reason = 'empty';
        // The dropped detectEmptyReason call was provably 'empty' here: the
        // if-chain above already handled !configuredState.ok and the
        // generating case, so enabled=true/generating=false/configured=ok.
        // Both remaining branches yield 'empty'; the renderer keys the CTA off ctx.isAnnotatable.
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

        // §6.4: wire the "Open settings" CTA — opens the Extensions drawer,
        // then expands the Generation Engine accordion and scrolls it into
        // view. FIX: the old code assumed the drawer was already open — on
        // mobile the fullscreen panel covers the screen and the drawer is
        // closed, so the click expanded an invisible accordion and visibly
        // did nothing.
        const configureCta = empty.querySelector('.gls-empty-configure');
        if (configureCta) {
            configureCta.addEventListener('click', () => {
                // ST drawer layout: #rm_extensions_block is the .drawer-content;
                // its .drawer ancestor (#extensions-settings-button) holds the
                // .drawer-toggle. ST flips closedDrawer→openDrawer synchronously
                // in the toggle's click handler, so one click opens the drawer.
                const content = document.getElementById('rm_extensions_block');
                if (content && !content.classList.contains('openDrawer')) {
                    content.closest('.drawer')?.querySelector('.drawer-toggle')?.click();
                }
                const container = document.getElementById('gls_settings_container');
                if (!container) return;
                // Expand + scroll after a frame: the drawer's slide-down starts
                // on the toggle click, and a same-tick scrollIntoView would
                // measure the still-collapsed content and miss the target.
                requestAnimationFrame(() => {
                    const header = container.querySelector('.gls-s-section-header');
                    if (header) {
                        const body2 = header.nextElementSibling;
                        if (body2?.hidden) header.click();
                        header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                });
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
        // post text) gets a badge since it has no marker in the chat. Regular
        // footnotes carry the same badge when flagged floating (their anchor
        // is not in the post — B#3); legacy anchored entries without context
        // selectors have no flag and stay badge-free.
        const main = makeEntryMain(fn, isTargeted);
        if (!fn.prefix && !fn.suffix && (isTargeted || fn.floating)) {
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

        const reRender = () => { panelInvalidate(); renderPanel(focusId); };
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
                const swipe = getCtx().chat?.[parseInt(msgId)]?.swipe_id ?? 0;
                reinjectInto(msgId, swipe);
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

function navigatePanel(dir) {
    const ids = getAllAnnotatableMsgIds();
    if (!ids.length) return;
    const curIdx = ids.indexOf(state.panelFocusMsgId ?? '');
    const nextIdx = curIdx + dir;
    if (nextIdx < 0 || nextIdx >= ids.length) return;
    state.panelFocusMsgId = ids[nextIdx];
    renderPanel(state.panelFocusMsgId);
    // Deliberately NO scrollIntoView on the chat: the arrows browse footnotes
    // inside the panel only. Jumping to the post is the header crosshair
    // button's job (explicit, on demand).
}

/** Scroll-observer hook: switch the focused message when the user scrolls. */
export function setVisiblePost(msgId) {
    // Scroll-follow exists only in panel display mode (elsewhere footnotes are
    // read where they sit, so the panel has no reason to chase the viewport).
    if (!S().floatingPanelEnabled || S().displayMode !== 'panel') return;
    if (state.panelFocusMsgId === String(msgId)) return;
    const ctx = getCtx();
    const msg = ctx.chat?.[parseInt(msgId)];
    if (!msg || msg.is_system) return;
    // User posts become focusable by the scroll-observer only when
    // glossUserMessages is on (mirrors getAllAnnotatableMsgIds).
    if (msg.is_user && !S().glossUserMessages) return;
    state.panelFocusMsgId = String(msgId);
    // Skip the render when the panel is hidden (pure churn) or a management
    // tab is active — rebuilding the Targeted textarea mid-edit drops its
    // focus/caret. The Footnotes tab picks the new focus up when reselected.
    if (!panelIsVisible()) return;
    if (_tabController && _tabController.getActiveTab() !== 'footnotes') return;
    renderPanel(msgId);
}
