// @ts-check
/**
 * Glosses — Connection module
 * Generation via ST Connection Profiles (connectionManager extension) or a
 * custom OpenAI-compatible chat completions endpoint (direct browser fetch).
 *
 * Ported + hardened from DS Comments/src/connection.js. API key lives in
 * localforage via core.js#getApiKey (NOT in settings JSON — spec §3.3).
 */

import { getCtx, S, warn, getApiKey, saveSettings } from './core.js';
import { classifyEndpoint, isOriginAllowed } from './infrastructure/endpoint-policy.js';

let _cmReady = false;
let _cmReadyChecked = false;

/**
 * Read connection-manager profiles — try ctx.extensionSettings first,
 * then fall back to global extension_settings (non-standard ST builds / mobile).
 */
function _getCMProfiles() {
    try {
        const ctx = getCtx();
        if (ctx?.extensionSettings?.connectionManager?.profiles?.length > 0) {
            return ctx.extensionSettings.connectionManager.profiles;
        }
    } catch {}
    try {
        const globalES = window?.extension_settings || globalThis?.extension_settings;
        if (globalES?.connectionManager?.profiles?.length > 0) {
            return globalES.connectionManager.profiles;
        }
    } catch {}
    return [];
}

/**
 * Wait for connectionManager to populate profiles (mobile / slow init).
 * Fast path on cached readiness; retries up to maxAttempts × delayMs.
 */
async function waitForConnectionManager(maxAttempts = 15, delayMs = 300) {
    if (_cmReady) return true;
    if (!_cmReadyChecked) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                _cmReadyChecked = true;
                return true;
            }
        } catch {}
        _cmReadyChecked = true;
    }
    for (let i = 0; i < maxAttempts; i++) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                return true;
            }
        } catch {}
        await new Promise(r => setTimeout(r, delayMs));
    }
    warn(`connectionManager not available after ${maxAttempts} attempts`);
    return false;
}

/**
 * List available CM profiles as {id, name}. Profiles with neither id nor name
 * are skipped — fabricating a random id (the old behaviour) made them
 * unselectable across settings saves.
 */
export async function getProfiles() {
    if (!(await waitForConnectionManager())) return [];
    try {
        return _getCMProfiles()
            .filter(p => p.id || p.name)
            .map(p => ({
                id:   p.id || p.name,
                name: p.name || p.id || 'Unknown Profile',
            }));
    } catch (e) {
        warn('getProfiles error:', e);
        return [];
    }
}

/**
 * Fetch the raw profile object for the given id-or-name (or null).
 */
export async function getProfileDetails(profileId) {
    if (!(await waitForConnectionManager())) return null;
    try {
        const profiles = _getCMProfiles();
        return profiles.find(p => p.id === profileId || p.name === profileId) || null;
    } catch (e) {
        warn('getProfileDetails error:', e);
        return null;
    }
}

/**
 * Pre-flight: is the generation source configured enough to ATTEMPT an
 * auto-generation? Mirrors the config-level throws in generateWithProfile /
 * generateWithCustomEndpoint - NOT the runtime CM-availability / profile-existence
 * checks (those still surface as error toasts from generateFootnotes, which is
 * correct for the manual regenerate path).
 *
 * Used by the auto-generate path (events.js) to skip silently - with one info
 * toast via state.configWarned - instead of toasting on every new AI message
 * while the source stays unconfigured (C3).
 *
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
export async function checkSourceConfigured() {
    const s = S();
    if (s.source === 'profile') {
        if (!s.selectedProfile) {
            return { ok: false, reason: 'No connection profile selected. Select a profile in Glosses settings.' };
        }
        return { ok: true, reason: '' };
    }
    if (s.source === 'custom') {
        if (!(s.customEndpoint || '').trim()) {
            return { ok: false, reason: 'Custom endpoint URL is empty. Set it in Glosses settings -> Custom.' };
        }
        // Stage 8: authorize the endpoint URL BEFORE reading the API key. A
        // malformed / non-http / credentialed URL must never reach the key read.
        const verdict = classifyEndpoint(s.customEndpoint);
        if (!verdict.ok) {
            return { ok: false, reason: verdict.error };
        }
        if (verdict.kind === 'insecure-http'
            && !isOriginAllowed(verdict.normalized, s.customEndpointAllowlist || [])) {
            return { ok: false, reason: 'Custom endpoint uses plain HTTP on a non-local host. Confirm this origin in Glosses settings before use.' };
        }
        const apiKey = await getApiKey();
        if (!apiKey) {
            return { ok: false, reason: 'Custom API key is not set. Set it in Glosses settings -> Custom.' };
        }
        return { ok: true, reason: '' };
    }
    return { ok: false, reason: 'Select a generation source (Connection Profile or Custom) in Glosses settings.' };
}

/**
 * Generate via a named Connection Profile.
 *
 * Human-readable errors are thrown in English (Glosses does not localize
 * thrown error messages; UI labels are localized via data-i18n). Abort is
 * normalized to a real AbortError DOMException so the generator renders the
 * "cancelled" state, not an error toast.
 */
export async function generateWithProfile(sel, systemPrompt, userPrompt, signal) {
    const ctx = getCtx();

    if (!sel) {
        throw new Error('No connection profile selected (Source = "Profile", but the profile is empty). Select a profile in Glosses settings.');
    }
    if (!ctx.ConnectionManagerRequestService?.sendRequest) {
        throw new Error('Connection Manager unavailable — enable the connection-manager extension or pick another source.');
    }
    if (!(await waitForConnectionManager())) {
        throw new Error('Connection Manager did not respond in time — verify a profile is selected in Connection Manager.');
    }

    let profile = null;
    try {
        const all = _getCMProfiles();
        profile = all.find(p => p.id === sel || p.name === sel) || null;
    } catch (e) {
        throw new Error(`Could not read Connection Manager profiles: ${e?.message || e}`);
    }
    if (!profile) {
        throw new Error(`Connection profile not found: "${sel}". It may have been deleted — reselect a profile in Glosses settings.`);
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
    ];

    let response;
    try {
        response = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id, messages, undefined,
            { stream: false, signal: signal || null, extractData: true, includePreset: false, includeInstruct: false },
        );
    } catch (e) {
        // CM wraps every failure as `new Error('API request failed', {cause})`,
        // so a real AbortError surfaces as e.cause. Normalize to a DOMException
        // so the generator renders the "cancelled" state, not an error toast.
        if (signal?.aborted || e?.name === 'AbortError' || e?.cause?.name === 'AbortError') {
            throw new DOMException('Aborted', 'AbortError');
        }
        const cause = e?.cause;
        const detail = cause?.message ? cause.message : (e?.message || String(e));
        throw new Error(`Profile "${profile.name}": ${detail}`);
    }

    const text = extractTextFromResponse(response);
    if (text !== null) return text;
    throw new Error(`Profile "${profile.name}" responded, but text could not be extracted.`);
}

/** Back-compat shim for the removed `callProfileAPI` import — deleted in
 *  v3.1 (spec §5.2). No external callers ever existed; the function was a
 *  maintenance tax whose premise was never validated. Kept as a marker
 *  comment so future readers don't reintroduce the shim.
 */

/**
 * Extract a plain-text answer from the various shapes connectionManager /
 * OpenAI / Gemini / Claude responses can take.
 */
function extractTextFromResponse(resp) {
    if (!resp) return null;
    if (typeof resp === 'string') return resp;
    if (Array.isArray(resp)) {
        const t = resp.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
        if (t.length) return t.join('\n');
    }
    if (resp.content !== undefined) {
        if (typeof resp.content === 'string') return resp.content;
        if (Array.isArray(resp.content)) {
            const t = resp.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
            if (t.length) return t.join('\n');
        }
    }
    if (resp.choices?.[0]?.message?.content) {
        const c = resp.choices[0].message.content;
        if (typeof c === 'string') return c;
    }
    if (Array.isArray(resp.candidates)) {
        const parts = resp.candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const texts = parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text);
            if (texts.length > 0) return texts.join('');
        }
    }
    if (typeof resp.text === 'string') return resp.text;
    if (typeof resp.message === 'string') return resp.message;
    if (typeof resp.message?.content === 'string') return resp.message.content;
    return null;
}

// ── Custom Endpoint Debug State ──
// Mirror of the last custom-endpoint request/response, for DevTools inspection.
// With settings.debugMode off (the default) only METADATA is captured
// (messageChars / textChars / status / durations) — full prompt bodies hold
// scene text and must not sit in memory for the page lifetime. Flip the mode
// via the Debug Menu ("Glosses: Toggle Debug Capture"). A dedicated Debug Menu
// reader is out of scope for this change.
export const lastCustomEndpointDebug = {
    request: null,   // debug: { url, model, messages, … } | meta: { url, model, messageChars, … }
    response: null,  // debug: { status, data, text, … } | meta: { status, textChars, … }
    error: null,     // { message, status, timestamp }
};

/**
 * Combine a caller-supplied abort signal with a timeout. The returned signal
 * aborts when EITHER the caller's signal aborts OR `ms` elapses. Uses the modern
 * AbortSignal.any()/timeout() (Baseline 2024: Chrome 116+, FF 124+, Safari 17.4+)
 * when available, with a manual AbortController fallback for older browsers.
 * Pass signal = null/undefined for a pure timeout. A timeout aborts with a
 * DOMException named 'TimeoutError' (distinct from a user cancel's 'AbortError').
 */
function withTimeoutSignal(signal, ms) {
    const hasAny = typeof AbortSignal.any === 'function';
    const hasTimeout = typeof AbortSignal.timeout === 'function';
    if (hasAny && signal && hasTimeout) {
        return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    }
    if (hasTimeout && !signal) {
        return AbortSignal.timeout(ms);
    }
    // Manual fallback (older browsers) - also used when only one of the APIs is
    // missing AND a caller signal is present.
    const tc = new AbortController();
    const to = setTimeout(() => tc.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    const wire = (sig) => {
        if (sig.aborted) { clearTimeout(to); tc.abort(sig.reason); }
        else sig.addEventListener('abort', () => { clearTimeout(to); tc.abort(sig.reason); }, { once: true });
    };
    if (signal) wire(signal);
    return tc.signal;
}

/**
 * Confirm (or reject) a custom endpoint's origin for an insecure-http URL.
 * Returns { ok: true } once the origin is on the allow-list; a persistence
 * failure rolls back the confirmation and rejects the request (plan stage 8).
 *
 * @param {string} normalizedUrl - canonicalized endpoint URL
 * @param {string[]} allowList - current S().customEndpointAllowlist
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function confirmInsecureEndpoint(normalizedUrl, allowList) {
    const next = [...(Array.isArray(allowList) ? allowList : [])];
    if (!next.some(item => {
        try {
            return new URL(item).hostname === new URL(normalizedUrl).hostname
                && new URL(item).protocol === new URL(normalizedUrl).protocol;
        } catch { return false; }
    })) {
        next.push(normalizedUrl);
    }
    try {
        S().customEndpointAllowlist = next;
        saveSettings();
    } catch {
        // Persistence failure: roll back and refuse the request.
        S().customEndpointAllowlist = allowList;
        return { ok: false, reason: 'Could not save the endpoint confirmation. Try again.' };
    }
    return { ok: true };
}

/**
 * Generate text via a custom OpenAI-compatible chat completions endpoint.
 * Sends ONLY the provided system + user prompts — no preset, no ST formatting.
 *
 * NOTE (CORS): this is a direct browser fetch(), NOT routed through the ST
 * server proxy. The endpoint MUST send permissive CORS headers, otherwise the
 * browser blocks the request. ST's built-in APIs proxy through the server;
 * a third-party custom endpoint cannot. If a provider refuses CORS, use the
 * "Profile" source instead.
 */
export async function generateWithCustomEndpoint(systemPrompt, userPrompt, signal, endpointUrl, model) {
    // Stage 8: authorize the endpoint URL BEFORE the API key read or fetch.
    // classifyEndpoint rejects non-http(s), credentialed, and malformed URLs;
    // a non-loopback http URL must be on the confirmed allow-list.
    const verdict = classifyEndpoint(endpointUrl);
    if (!verdict.ok) throw new Error(verdict.error);
    if (verdict.kind === 'insecure-http'
        && !isOriginAllowed(verdict.normalized, S().customEndpointAllowlist || [])) {
        throw new Error('Custom endpoint uses plain HTTP on a non-local host. Confirm this origin in Glosses settings before use.');
    }
    const url = verdict.normalized;

    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('Custom API key is not set. Set it in Glosses settings → Custom.');

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const body = { messages, stream: false };
    if (model) body.model = model;

    // Debug capture gate: with debugMode off (default) only metadata is
    // retained below — full prompt bodies must not sit in memory for the
    // whole page lifetime (port of DS Comments).
    const debugFull = S().debugMode === true;

    lastCustomEndpointDebug.request = debugFull
        ? { url, model: model || '(default)', messages, stream: false, timestamp: Date.now() }
        // Outside debug mode only metadata is kept — full prompt bodies must
        // not sit in memory for the whole page lifetime (port of DS Comments).
        : {
            url,
            model: model || '(default)',
            messageChars: messages.map(m => (m?.content || '').length),
            stream: false,
            timestamp: Date.now(),
        };
    lastCustomEndpointDebug.response = null;
    lastCustomEndpointDebug.error = null;

    const t0 = performance.now();

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: withTimeoutSignal(signal, 60_000),
        });
    } catch (e) {
        if (e?.name === 'TimeoutError') {
            throw new Error('Custom endpoint timed out (60s) - the server accepted the connection but did not respond.');
        }
        throw e;
    }

    const durationMs = Math.round(performance.now() - t0);

    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        const errMsg = `HTTP ${response.status}: ${errText.slice(0, 300)}`;
        lastCustomEndpointDebug.error = { message: errMsg, status: response.status, timestamp: Date.now() };
        console.error(`[Glosses] [Custom Endpoint] ✗ ${errMsg}`);
        throw new Error(`Custom endpoint ${errMsg}`);
    }

    const data = await response.json();
    const text = extractTextFromResponse(data);

    lastCustomEndpointDebug.response = debugFull
        ? {
            status: response.status,
            data,
            text: text || '(empty)',
            timestamp: Date.now(),
            durationMs,
        }
        : {
            status: response.status,
            textChars: (text || '').length,
            timestamp: Date.now(),
            durationMs,
        };

    if (text !== null) return text;
    warn('Custom endpoint: could not extract text from response', data);
    return '';
}