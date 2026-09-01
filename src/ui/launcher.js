// @ts-check
/**
 * Glosses — Launcher button (in the quick-reply bar) + re-mount observer.
 *
 * A Tⁿ (footnote) button in #qr--bar that toggles the floating footnotes panel
 * on/off. SillyTavern rebuilds #send_form / #qr--bar on chat switch, group
 * change, and quick-reply edits — a MutationObserver on #send_form re-mounts
 * the launcher when that happens. #send_form is lazy-mounted by ST, so we poll
 * briefly if it isn't present yet.
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

import { S, saveSettings, t } from '../core.js';

let _launcherObserver = null;
let _launcherPoll = null;
let _launcherPollStop = null;
let _launcherDebounce = null;

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
 * Create or refresh the launcher button. Idempotent: if it already exists it
 * is re-parented to the current host and its active state is re-synced.
 * Returns the button element, or null if there is no host or footnotes are off.
 */
export function ensureLauncher() {
    const existing = document.getElementById('gls_launcher');
    if (!S().enabled) {
        existing?.remove();
        document.body.classList.remove('gls-launcher-mounted');
        return null;
    }
    const host = getLauncherHost();
    if (!host) {
        document.body.classList.remove('gls-launcher-mounted');
        return null;
    }

    let btn = existing;
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
    return btn;
}

/**
 * Launcher click handler: reconcile the panel visibility. The launcher doubles
 * as both re-show (after a ✕ close) and the permanent toggle-off.
 *
 *   panel visible        → toggle off permanently (floatingPanelEnabled=false)
 *   panel hidden + enabled → un-hide + clear the persisted floatingPanelHidden
 *   panel not mounted + disabled → first click enables + builds
 */
async function toggleLauncherPanel() {
    if (!S().enabled) return;
    // Dynamic import to avoid a launcher↔window cycle.
    const { updatePanel, panelIsVisible, getPanel } = await import('./window.js');

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
        // If the panel was destroyed for some reason (chat switch mid-✕), build it.
        const panel = getPanel();
        S().floatingPanelHidden = false;
        saveSettings();
        if (panel) {
            panel.style.display = '';
            updatePanel();
        } else {
            S().floatingPanelEnabled = true; // already true — re-arm updatePanel
            updatePanel();
            if (S().floatingPanelEnabled) {
                try {
                    const { initScrollObserver } = await import('../events.js');
                    setTimeout(initScrollObserver, 0);
                } catch { /* non-critical */ }
            }
        }
    } else {
        // Disabled in settings — first click enables (fresh, visible).
        S().floatingPanelEnabled = true;
        S().floatingPanelHidden = false;
        saveSettings();
        updatePanel();
        if (S().floatingPanelEnabled) {
            try {
                const { initScrollObserver } = await import('../events.js');
                setTimeout(initScrollObserver, 0);
            } catch { /* non-critical */ }
        }
    }
    ensureLauncher();
    const cb = document.getElementById('gls_floating_panel');
    if (cb) cb.checked = S().floatingPanelEnabled;
}

/**
 * Attach the MutationObserver on #send_form so the launcher re-mounts after
 * ST rebuilds the quick-reply bar. Polls for up to 8s if #send_form isn't
 * mounted yet. Safe to call repeatedly (guards on _launcherObserver).
 */
export function observeQrBar() {
    if (_launcherObserver) return;
    const tryAttach = () => {
        const sendForm = document.getElementById('send_form');
        if (!sendForm) return false;
        _launcherObserver = new MutationObserver(() => {
            if (_launcherDebounce) clearTimeout(_launcherDebounce);
            _launcherDebounce = setTimeout(() => { _launcherDebounce = null; if (S().enabled) ensureLauncher(); }, 100);
        });
        _launcherObserver.observe(sendForm, { childList: true, subtree: true });
        return true;
    };
    if (!tryAttach()) {
        _launcherPoll = setInterval(() => { if (tryAttach()) { clearInterval(_launcherPoll); _launcherPoll = null; } }, 500);
        // Owned stop guard: previously a closure-local timeout leaked past
        // removeLauncher(), so a disable during the attach window could still
        // clear the poll after teardown.
        _launcherPollStop = setTimeout(() => {
            _launcherPollStop = null;
            if (_launcherPoll) { clearInterval(_launcherPoll); _launcherPoll = null; }
        }, 8000);
    }
}

/** Tear down: remove button + disconnect observer + cancel all timers. Called from cleanup(). */
export function removeLauncher() {
    document.getElementById('gls_launcher')?.remove();
    document.body.classList.remove('gls-launcher-mounted');
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    if (_launcherDebounce) { clearTimeout(_launcherDebounce); _launcherDebounce = null; }
    if (_launcherPoll) { clearInterval(_launcherPoll); _launcherPoll = null; }
    if (_launcherPollStop) { clearTimeout(_launcherPollStop); _launcherPollStop = null; }
}
