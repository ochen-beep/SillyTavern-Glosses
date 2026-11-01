// @ts-check
/**
 * Glosses — Generation-source settings UI.
 *
 * Extracted verbatim from settings-sync.js (R-7.5 module split): the
 * insecure-endpoint confirmation flow (endpoint-policy behind a settings
 * surface) and the Connection-Profile dropdown/profile-info/API-key sync.
 */

import { S, saveSettings, t, notifyUser, getApiKey } from '../core.js';
import { getProfiles, getProfileDetails, confirmInsecureEndpoint } from '../connection.js';
import { classifyEndpoint, isOriginAllowed } from '../infrastructure/endpoint-policy.js';

// ── Insecure-endpoint confirmation (plan stage 8, UI half) ──
// The policy layer (endpoint-policy.js + connection.js) refuses plain HTTP on
// non-loopback hosts until the origin is confirmed. These functions are the
// settings-surface half of that flow: a hint + confirm button inside the
// Custom panel while the endpoint is an unconfirmed insecure-http URL, and an
// informational hint for loopback http (allowed, but not encrypted).

function httpConfirmEls() {
    return {
        group: document.getElementById('gls_http_confirm_group'),
        text: document.getElementById('gls_http_confirm_text'),
        btn: document.getElementById('gls_http_confirm_btn'),
    };
}

export function refreshHttpConfirm() {
    const { group, text } = httpConfirmEls();
    if (!group || !text) return;
    if (S().source !== 'custom') { group.hidden = true; return; }
    const verdict = classifyEndpoint(S().customEndpoint);
    if (!verdict.ok) { group.hidden = true; return; }
    if (verdict.kind === 'insecure-http'
        && !isOriginAllowed(verdict.normalized, S().customEndpointAllowlist || [])) {
        let host = verdict.host;
        try { host = new URL(verdict.normalized).host || verdict.host; } catch { /* keep raw host */ }
        text.textContent = `${t('This endpoint uses plain HTTP outside localhost. Confirm the origin to allow requests — the API key will be sent unencrypted.')} [${host}]`;
        group.hidden = false;
        return;
    }
    if (verdict.kind === 'loopback-http') {
        text.textContent = t('Local HTTP endpoint (localhost) — requests are allowed, but the key is not encrypted.');
        group.hidden = false;
        return;
    }
    group.hidden = true;
}

export function bindHttpConfirm() {
    const { btn } = httpConfirmEls();
    refreshHttpConfirm();
    if (!btn || btn.dataset.glsHttpConfirmBound === '1') return;
    // Plain listener (not the bind-scoped `on()`): the settings DOM is
    // recreated on every enable, so the element lifetime bounds the listener.
    btn.dataset.glsHttpConfirmBound = '1';
    btn.addEventListener('click', () => {
        const verdict = classifyEndpoint(S().customEndpoint);
        if (!verdict.ok || verdict.kind !== 'insecure-http') { refreshHttpConfirm(); return; }
        confirmInsecureEndpoint(verdict.normalized, S().customEndpointAllowlist || []);
        try { notifyUser('success', t('Endpoint origin confirmed.'), 'gls-http-confirm'); } catch { /* non-fatal */ }
        refreshHttpConfirm();
    });
}

let _modelInfoReq = 0;
/** Show "<API> · <model>" under the selected profile (race-guarded). */
export function updateProfileModelInfo() {
    const info = document.getElementById('gls_profile_info');
    const txt  = document.getElementById('gls_profile_model');
    if (!info || !txt) return;
    const req = ++_modelInfoReq;
    txt.textContent = '';
    if (S().source !== 'profile' || !S().selectedProfile) {
        info.hidden = true;
        return;
    }
    getProfileDetails(S().selectedProfile).then(d => {
        if (req !== _modelInfoReq) return;
        if (!d) { info.hidden = true; return; }
        const parts = [];
        const api = d.api || '';
        if (api) parts.push(String(api).toUpperCase());
        const model = d.model || d.modelName || d.model_name || d.settings?.model || '';
        if (model) parts.push(String(model));
        if (!parts.length && d.name) parts.push(d.name);
        txt.textContent = parts.length ? parts.join(' · ') : t('Profile selected (no model data)');
        info.hidden = false;
    }).catch(() => { if (req === _modelInfoReq) info.hidden = true; });
}

/** In-flight localforage write for the custom API key (see binding below). */
let _apiKeySave = null;

/** Load the localforage-backed API key into the password field. */
export function syncCustomApiKeyField(el) {
    const input = el || document.getElementById('gls_custom_apikey');
    if (!input) return;
    // Never clobber the field while the user is editing it (or while a save
    // from that editing is still in flight) — a panel update that lands
    // mid-typing otherwise overwrites the input with the stale stored key and
    // the value looks committed when it is not.
    const fill = async () => {
        if (_apiKeySave) await _apiKeySave;
        if (document.activeElement === input) return;
        const key = await getApiKey();
        if (document.activeElement === input) return;
        input.value = key || '';
    };
    fill();
}

export async function populateProfiles() {
    const sel = document.getElementById('gls_profile_select');
    if (!sel) return;
    sel.innerHTML = `<option value="">${t('-- Select Profile --')}</option>`;
    try {
        const profiles = await getProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            sel.appendChild(opt);
        }
        if (S().selectedProfile && profiles.some(p => p.id === S().selectedProfile || p.name === S().selectedProfile)) {
            sel.value = S().selectedProfile;
        } else {
            if (S().selectedProfile) { S().selectedProfile = ''; saveSettings(); }
            sel.value = '';
        }
    } catch { /* profiles unavailable */ }
}
