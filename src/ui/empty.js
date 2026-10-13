// @ts-check
/**
 * Glosses — Centralized empty-state renderer for the floating panel.
 *
 * Replaces the inline empty-state branches that were scattered through
 * window.js renderPanel() (the "No messages", "No footnotes", CTA, and
 * "Generating" cases). One place to reason about what the panel shows when
 * there's nothing to render.
 *
 * Ported from DS Comments/src/ui/empty.js (gls- prefix, Glosses vocabulary).
 */

import { t, escapeHtml } from '../core.js';
import { iconHtml } from './icons.js';

/**
 * Decide *why* the panel has nothing to show.
 * @param {{enabled: boolean, generating: boolean, configured?: {ok: boolean}}} s
 * @returns {'disabled' | 'no-ai' | 'generating' | 'unconfigured' | 'empty'}
 */
export function detectEmptyReason({ enabled, generating, configured }) {
    if (!enabled) return 'disabled';
    // §6.4: unresolved source-configured state wins over the generating /
    // empty reasons so the badge stays visible until a successful generation
    // flips state.configuredState back to ok.
    if (configured && !configured.ok) return 'unconfigured';
    if (generating) return 'generating';
    return 'empty';
}

/**
 * Build the inner HTML for an empty panel body. The host (window.js) still
 * owns wiring the CTA click - it returns a marker class so the host can find
 * it via querySelector('.gls-empty-generate') / querySelector('.gls-empty-configure').
 *
 * @param {'disabled' | 'no-ai' | 'generating' | 'unconfigured' | 'empty'} reason
 * @param {{isAnnotatable?: boolean, reason?: string}} [ctx]
 * @returns {string} HTML string
 */
export function renderEmptyStateHTML(reason, ctx = {}) {
    const icon = (name) => `<div class="gls-empty-icon">${iconHtml(name, { size: 28 })}</div>`;
    switch (reason) {
        case 'no-ai':
            return `${icon('message')}<div class="gls-empty-text">${t('No messages.')}</div>`;
        case 'generating':
            return `${icon('spinner', { spin: true })}<div class="gls-empty-text">${t('Generating footnotes...')}</div>`;
        case 'unconfigured':
            // §6.4: persistent Source-not-configured badge with the failure
            // reason + an "Open settings" CTA. window.js wires the CTA to
            // open the Extensions drawer and expand the Generation Engine
            // accordion. A non-empty ctx.reason means the source IS configured
            // but the last attempt failed (API/transport error carried in the
            // reason) — head the badge with that instead of the misleading
            // "not configured".
            return `${icon('warn')}<div class="gls-empty-text">${ctx.reason ? t('Generation source error') : t('Source not configured')}</div>` +
                (ctx.reason ? `<div class="gls-empty-reason">${escapeHtml(ctx.reason)}</div>` : '') +
                `<button class="menu_button gls-empty-configure" type="button">${t('Open settings')}</button>`;
        case 'empty':
            // Annotatable message (AI, or {{user}} when glossUserMessages is on)
            // with no footnotes yet -> offer a CTA.
            if (ctx.isAnnotatable) {
                return `${icon('sparkles')}<div class="gls-empty-text">${t('No footnotes for this message.')}</div>` +
                    `<button class="menu_button gls-empty-generate" type="button">${t('Generate')}</button>`;
            }
            return `<div class="gls-empty-text">${t('No footnotes for this message.')}</div>`;
        case 'disabled':
        default:
            return `<div class="gls-empty-text">${t('Footnotes are disabled.')}</div>`;
    }
}
