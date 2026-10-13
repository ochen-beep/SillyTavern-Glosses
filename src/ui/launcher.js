// @ts-check
/**
 * Glosses — Launcher buttons (quick-reply bar + floating FAB) + re-mount observer.
 *
 * settings.launcherMode ('bar' | 'floating' | 'both') picks which launcher(s)
 * are shown: a Tⁿ (footnote) button in #qr--bar, the draggable floating button
 * (floating-launcher.js), or both. The bar button toggles the floating footnotes
 * panel on/off; the FAB shares the same toggle semantics. SillyTavern rebuilds
 * #send_form / #qr--bar on chat switch, group change, and quick-reply edits —
 * a MutationObserver on #send_form re-mounts the launcher when that happens.
 * #send_form is lazy-mounted by ST: until it appears we wait on APP_READY
 * (whenSendFormReady), not a polling timer. The FAB mounts independently of the
 * QR bar, so the panel stays reachable even with the Quick Replies extension
 * disabled.
 *
 * v3.1 (spec §6.3 + §6.8): ✕ now hides (not destroys) and the launcher
 * re-shows; the active-state class tracks VISIBILITY (not floatingPanelEnabled
 * alone).
 *
 * v3.2: the icon switched from the hand-drawn Tⁿ SVG glyph to Font Awesome's
 * fa-superscript — the same glyph the per-message regen button uses, so the
 * two controls that both mean "footnotes" read as one family. FA is already
 * loaded by SillyTavern everywhere the QR bar renders.
 *
 * Ported from DS Comments/index.js launcher logic (dsc→gls, toggles
 * floatingPanelEnabled instead of `collapsed`).
 */

import { S, saveSettings, t, warn, debounce } from '../core.js';
import { whenSendFormReady } from './dom-ready.js';
import { ensureFloatingLauncher, removeFloatingLauncher } from './floating-launcher.js';

let _launcherObserver = null;
const _debouncedEnsureLauncher = debounce(() => { if (S().enabled) ensureLauncher(); }, 100);
// Disposer for the pending APP_READY subscription (when #send_form wasn't
// mounted yet at attach time). cleanup() → removeLauncher() MUST invoke it,
// or an extension disabled before APP_READY gets its launcher re-attached by
// the still-subscribed listener after teardown.
let _launcherReadyDispose = null;

/** Find the quick-reply bar (#qr--bar). ST mounts it inside #send_form. */
function getQuickReplyBar() {
    return document.querySelector('#send_form #qr--bar')
        || document.getElementById('qr--bar')
        || document.querySelector('#send_form .qr--bar');
}

/**
 * Where to mount the launcher. #qr--bar has flex-wrap:wrap and its .qr--button
 * styling is scoped to `#qr--bar > .qr--buttons .qr--button` — a bare child of
 * #qr--bar gets neither styling nor a proper flex slot and wraps to a new line
 * on mobile. Prefer the inner .qr--buttons row when it exists.
 */
function getLauncherHost() {
    const qrBar = getQuickReplyBar();
    if (!qrBar) return null;
    return qrBar.querySelector('.qr--buttons') || qrBar;
}

/**
 * Create or refresh the launcher controls. Idempotent: the bar button, if it
 * already exists, is re-parented to the current host and its active state is
 * re-synced; the FAB re-syncs its highlight. Returns the bar button element,
 * or null if footnotes are off, the mode is 'floating', or there is no QR-bar
 * host (the FAB, when wanted, is ensured regardless of the host).
 */
export function ensureLauncher() {
    const existing = document.getElementById('gls_launcher');
    if (!S().enabled) {
        existing?.remove();
        document.body.classList.remove('gls-launcher-mounted');
        removeFloatingLauncher();
        return null;
    }
    const mode = S().launcherMode || 'bar';
    const wantBar = mode === 'bar' || mode === 'both';
    const wantFab = mode === 'floating' || mode === 'both';

    // The FAB mounts into <body> independently of the QR bar.
    if (wantFab) ensureFloatingLauncher({ onToggle: toggleLauncherPanel });
    else removeFloatingLauncher();

    let btn = null;
    if (wantBar) {
        const host = getLauncherHost();
        if (host) {
            btn = existing;
            if (!btn) {
                btn = document.createElement('div');
                btn.id = 'gls_launcher';
                btn.className = 'qr--button menu_button interactable gls_launcher';
                btn.tabIndex = 0;
                btn.setAttribute('role', 'button');
                btn.setAttribute('aria-label', t('Show footnotes panel'));
                btn.title = t('Show footnotes panel');
                btn.innerHTML = '<span aria-hidden="true"><i class="fa-solid fa-superscript"></i></span>';
                btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleLauncherPanel(); });
                btn.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLauncherPanel(); }
                });
            }
            if (btn.parentElement !== host) host.appendChild(btn);
            document.body.classList.add('gls-launcher-mounted');
        }
    }
    if (!btn && existing) existing.remove();
    if (!btn) document.body.classList.remove('gls-launcher-mounted');
    if (btn) {
        // §6.3: active state follows VISIBILITY, not floatingPanelEnabled alone —
        // a ✕-hidden-but-enabled panel is not 'visibly active'. Inline DOM read
        // (panel id = 'gls-panel') avoids a launcher↔window import cycle that the
        // other dynamic-imports already work around.
        let visible = false;
        try {
            const panel = document.getElementById('gls-panel');
            visible = !!panel && panel.style.display !== 'none';
        } catch { /* ignore */ }
        btn.classList.toggle('gls_launcher_active', S().floatingPanelEnabled && visible);
    }
    return btn;
}

/**
 * Launcher click handler: reconcile the panel visibility. The launcher doubles
 * as both re-show (after a ✕ close) and the permanent toggle-off.
 *
 *   panel visible        → toggle off permanently (floatingPanelEnabled=false)
 *   panel hidden + enabled → un-hide + clear the persisted floatingPanelHidden
 *   panel not mounted + disabled → first click enables + builds
 *
 * Serialized through a promise chain: the handler awaits dynamic imports, and
 * both launcher buttons (QR bar + FAB) call it, so rapid clicks used to
 * interleave — the second click could read panel state from the middle of the
 * first toggle and the open/close alternation became unpredictable. Queuing
 * makes every click observe the fully committed state of the previous one.
 */
let _toggleChain = Promise.resolve();
function toggleLauncherPanel() {
    const run = _toggleChain.then(toggleLauncherPanelNow, toggleLauncherPanelNow);
    // Keep the chain alive even if a toggle throws, and LOG the failure — a
    // silently swallowed rejection here once hid a buildPanel ReferenceError
    // (the panel simply never appeared, no console trace).
    _toggleChain = run.catch(() => {});
    run.catch(e => warn('Panel toggle failed:', e));
    return run;
}

async function toggleLauncherPanelNow() {
    if (!S().enabled) return;
    // Dynamic import to avoid a launcher↔window cycle.
    const { updatePanel, panelIsVisible } = await import('./window.js');

    if (panelIsVisible()) {
        // Visible → toggle off permanently (the "I don't want the panel anymore" path).
        // Reset the persisted hide too so a later re-enable starts fresh (visible).
        S().floatingPanelEnabled = false;
        S().floatingPanelHidden = false;
        saveSettings();
        updatePanel();
        ensureLauncher();
        const cb = document.getElementById('gls_floating_panel');
        if (cb) cb.checked = false;
        return;
    }

    if (S().floatingPanelEnabled) {
        // Enabled-but-hidden (after a prior ✕) → un-hide and persist that choice.
        // The flag must be cleared BEFORE updatePanel(), which reconciles
        // display from it (leaving it set would re-hide the panel instantly).
        // updatePanel() itself rebuilds the panel if it was destroyed (chat
        // switch mid-✕), so no local getPanel() branch is needed.
        S().floatingPanelHidden = false;
        saveSettings();
        updatePanel();
    } else {
        // Disabled in settings — first click enables (fresh, visible).
        S().floatingPanelEnabled = true;
        S().floatingPanelHidden = false;
        saveSettings();
        updatePanel();
    }
    await rearmScrollObserver();
    ensureLauncher();
    const cb = document.getElementById('gls_floating_panel');
    if (cb) cb.checked = S().floatingPanelEnabled;
}

// After the launcher (re)enables the panel, re-arm the panel-mode scroll
// observer (torn down with the panel). Deferred a tick so the panel exists.
async function rearmScrollObserver() {
    if (!S().floatingPanelEnabled) return;
    try {
        const { initScrollObserver } = await import('../events.js');
        setTimeout(initScrollObserver, 0);
    } catch { /* non-critical */ }
}

/**
 * Attach the MutationObserver on #send_form so the launcher re-mounts after
 * ST rebuilds the quick-reply bar (chat switch, group change, QR edits).
 * #send_form is lazy-mounted by ST: when it isn't in the DOM yet, wait on
 * APP_READY via whenSendFormReady (event-driven, no polling deadline) instead
 * of a setInterval probe. Safe to call repeatedly (guards on _launcherObserver).
 */
export function observeQrBar() {
    if (_launcherObserver || _launcherReadyDispose) return;
    const attachObserver = (sendForm) => {
        _launcherObserver = new MutationObserver(() => {
            _debouncedEnsureLauncher();
        });
        _launcherObserver.observe(sendForm, { childList: true, subtree: true });
    };
    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        attachObserver(sendForm);
        return;
    }
    // #send_form not mounted yet — subscribe to APP_READY. Store the disposer:
    // a disable before the event must unsubscribe, or the late event attaches
    // an orphaned observer + launcher button after teardown.
    _launcherReadyDispose = whenSendFormReady(attachObserver, {
        onGiveUp: () => { _launcherReadyDispose = null; },
    });
}

/** Tear down: remove both launchers (bar button + FAB), disconnect observer
 *  and cancel the disposer and the debounce timer. Called from cleanup(). */
export function removeLauncher() {
    document.getElementById('gls_launcher')?.remove();
    document.body.classList.remove('gls-launcher-mounted');
    removeFloatingLauncher();
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    _debouncedEnsureLauncher.cancel();
    if (_launcherReadyDispose) { _launcherReadyDispose(); _launcherReadyDispose = null; }
}
