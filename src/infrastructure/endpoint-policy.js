// @ts-check
/**
 * Glosses — Custom endpoint policy (plan stage 8)
 *
 * Pure URL classification for the custom OpenAI-compatible endpoint. Enforced
 * BEFORE any API key read or fetch so a malformed / insecure URL can never
 * trigger a credentialed request.
 *
 * Rules:
 *   - protocol must be http: or https: (javascript:, file:, data:, ftp: … are
 *     rejected outright);
 *   - credentials in the URL (user:pass@host) are rejected — they'd be sent to
 *     the wrong origin on redirect and can leak in logs;
 *   - the path is canonicalized to a chat completions URL:
 *       bare host            → /v1/chat/completions
 *       …/v1                 → …/v1/chat/completions
 *       …/chat/completions   → as-is
 *   - classification:
 *       https:                → 'https' (safe)
 *       http: + loopback      → 'loopback-http' (localhost / 127.0.0.1 / ::1 —
 *                                allowed with a warning; no cross-origin risk)
 *       http: + non-loopback  → 'insecure-http' (clear-text credentials over
 *                                the network — requires explicit origin
 *                                confirmation before the request proceeds)
 *
 * The module is host-agnostic (no DOM / ST deps) so it is unit-testable.
 */

/** @typedef {{ ok: true, kind: 'https' | 'loopback-http' | 'insecure-http', normalized: string, host: string }}
 *         | { ok: false, error: string }} EndpointVerdict */

function isLoopbackHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'localhost'
        || h === '127.0.0.1'
        || h === '[::1]'
        || h === '::1'
        || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
        || h === '0.0.0.0';
}

/**
 * Classify and canonicalize a custom endpoint URL.
 *
 * @param {string} raw
 * @returns {EndpointVerdict}
 */
export function classifyEndpoint(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return { ok: false, error: 'Custom endpoint URL is empty.' };

    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return { ok: false, error: `Invalid URL: "${input}". Use http(s)://host[:port]/path.` };
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
        return { ok: false, error: `Unsupported protocol "${protocol}". Only http(s):// is allowed.` };
    }
    if (parsed.username || parsed.password) {
        return { ok: false, error: 'URL must not contain credentials (user:pass@). Set the API key separately in settings.' };
    }

    const host = parsed.host;
    const kind = protocol === 'https:'
        ? 'https'
        : (isLoopbackHost(parsed.hostname) ? 'loopback-http' : 'insecure-http');

    // Canonicalize: strip the hash, keep the query aside, normalize the PATH to
    // a chat completions URL, then re-attach the query. Operating on the raw
    // string glued /v1/chat/completions onto query strings
    // (https://host/v1?key=x → …?key=x/v1/chat/completions — a dead endpoint).
    parsed.hash = '';
    const query = parsed.search;
    parsed.search = '';
    const pathOnly = parsed.pathname.replace(/\/+$/, '');
    let normalizedPath;
    if (/\/chat\/completions$/i.test(pathOnly)) normalizedPath = pathOnly;
    else if (/\/v1$/i.test(pathOnly)) normalizedPath = `${pathOnly}/chat/completions`;
    else normalizedPath = `${pathOnly}/v1/chat/completions`;
    const normalized = `${parsed.origin}${normalizedPath}${query}`;

    return { ok: true, kind, normalized, host };
}

/**
 * Is this URL on the confirmed-origin allow-list? Used for the non-loopback
 * HTTP confirmation flow (persisted so the user isn't re-asked every request).
 *
 * @param {string} normalizedUrl
 * @param {string[]} allowList
 * @returns {boolean}
 */
export function isOriginAllowed(normalizedUrl, allowList) {
    if (!normalizedUrl || !Array.isArray(allowList)) return false;
    try {
        const u = new URL(normalizedUrl);
        return allowList.some(item => {
            try {
                // Origin compare = scheme + host + PORT: confirming
                // http://host:1234 must not also authorize http://host:9999 —
                // the user confirmed one concrete endpoint, not the whole host.
                // (The path stays unpinned: allow-list entries are canonical
                // …/v1/chat/completions URLs, the request URL is canonicalized
                // the same way before this check.)
                return new URL(item).origin === u.origin;
            } catch { return false; }
        });
    } catch { return false; }
}
