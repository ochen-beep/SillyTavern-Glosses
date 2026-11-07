// @ts-check
/**
 * Glosses — Context blocks for the annotation prompt.
 *
 * Extracted verbatim from generator.js (R-7.2 module split): the single
 * generation turn's [Annotate this post] target block plus the background
 * blocks (scene history, character card, persona, world info, forbidden
 * anchors). buildUserPrompt (generator.js) is the only production consumer;
 * unit tests import buildLoreScanInput/buildContextBlocks directly.
 */

import { getCtx, S, extractPlainText } from './core.js';
import { listFootnoteSets, getForcedIgnore, getPoolExcluded } from './cache.js';
import { collectExplainedAnchors, combineForbiddenAnchors } from './anchor-policy.js';
import {
    getChatLoreConfig, collectAutomaticLore, resolveManualLore,
    LORE_MODE, LORE_SCOPE, LORE_SCAN_MAX_CONTEXT,
} from './lorebooks.js';

/** Coerce arbitrary WI/persona return shapes into a plain string. */
function coercePromptText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(coercePromptText).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        if (typeof value.worldInfoString === 'string') return value.worldInfoString;
        if (typeof value.worldInfoBefore === 'string' || typeof value.worldInfoAfter === 'string') {
            return [value.worldInfoBefore, value.worldInfoAfter].filter(Boolean).join('\n');
        }
        if (typeof value.prompt === 'string') return value.prompt;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.text === 'string') return value.text;
        if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
            const str = value.toString();
            if (str && str !== '[object Object]') return str;
        }
        try { const json = JSON.stringify(value); return json && json !== '{}' ? json : ''; } catch { return ''; }
    }
    const str = String(value);
    return str === '[object Object]' ? '' : str;
}

/**
 * Build the input consumed by SillyTavern's automatic lore activation
 * (getWorldInfoPrompt). Ported from DS Comments (src/generator.js).
 *   - Messages newest-first (ST's scan expects reverse-chronological order)
 *     with raw m.mes — the same surface ST itself scans.
 *   - globalScanData carries the 'quiet' trigger plus the persona/character
 *     fields whose TEXT can activate keyword entries: without them, entries
 *     keyed on words that appear only in the character description, scenario,
 *     or persona never activate for the footnote prompt.
 */
export function buildLoreScanInput(ctx) {
    const chatMessages = (ctx.chat || [])
        .filter(m => m && !m.is_system && !m.is_hidden)
        .map(m => {
            const name = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
            return `${name}: ${String(m.mes || '')}`;
        })
        .reverse();

    const globalScanData = { trigger: 'quiet' };
    try {
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            const ch = ctx.characters[ctx.characterId];
            if (ch.description) globalScanData.characterDescription = ch.description;
            if (ch.personality) globalScanData.characterPersonality = ch.personality;
            if (ch.scenario) globalScanData.scenario = ch.scenario;
        }
        const pd = ctx.powerUserSettings?.persona_description;
        if (pd) globalScanData.personaDescription = pd;
    } catch { /* skip */ }

    return { chatMessages, globalScanData };
}

function buildCharBlock(messageId) {
    const ctx = getCtx();
    let ch = null;
    if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
        ch = ctx.characters[ctx.characterId];
    } else {
        const msg = ctx.chat?.[parseInt(messageId)];
        if (msg?.name) ch = ctx.characters?.find(c => c.name === msg.name) ?? null;
    }
    if (!ch?.description) return '';
    // Full card, mirroring buildLoreScanInput's field set: personality and
    // scenario are annotation background just like the description.
    const parts = [ch.description];
    if (ch.personality) parts.push(`Personality: ${ch.personality}`);
    if (ch.scenario) parts.push(`Scenario: ${ch.scenario}`);
    return `[Character: ${ch.name}\n${parts.join('\n\n')}]`;
}

function buildChatHistory(anchorMsgId) {
    const ctx = getCtx();
    const depth = Math.max(0, parseInt(S().contextDepth, 10) || 0);
    const chat = ctx.chat;
    if (!chat || depth <= 0) return '';
    // Context is STRICTLY prior messages. The anchor post is annotated via
    // [Annotate this post] and must NOT also appear here — otherwise the model
    // starts generating footnotes for older posts' words instead of the
    // current one.
    const endIdx = parseInt(anchorMsgId, 10); // exclusive of the anchor
    return chat
        .slice(0, endIdx)
        .slice(-depth)
        .filter(m => !m.is_system && !m.is_hidden)
        .map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'AI')}: ${extractPlainText(m.mes || '')}`)
        .join('\n');
}

/**
 * Build the context blocks for the single generation turn: the annotation
 * target ([Annotate this post], the ONLY block validateFootnotes resolves
 * anchors against — see extractPostTextFromPrompt in parser.js) + background
 * blocks the model may use to enrich explanations ([Earlier in the scene],
 * Character, User persona, World info). Background is reference context, never
 * an anchor source. The first element is always [Annotate this post: ...], so
 * extractPostTextFromPrompt can resolve anchors against the target alone.
 */

/**
 * Read the current persona description, preferring ctx.getPersonaDescription
 * (older ST) and falling back to ctx.powerUserSettings + personas.js's
 * `user_avatar` named export (newer ST where ctx.getPersonaDescription is
 * no longer exposed via getContext). Never throws — returns '' on any
 * failure (the persona block is opt-in enrichment; a missing description
 * is not an error, just a degraded footnote).
 *
 * Verified against release (paths from third-party/<ext>/src/generator.js):
 *   - ctx.powerUserSettings: exposed in getContext() (st-context.js:228)
 *   - user_avatar: named export of public/scripts/personas.js:108
 *   - persona_descriptions: power_user field (power-user.js), keyed by avatar
 */
let _userAvatarImport = null; // memoize the dynamic personas.js import
async function getPersonaDescription() {
    const ctx = getCtx();
    // Preferred path (older ST versions that still expose it).
    if (typeof ctx.getPersonaDescription === 'function') {
        try { return ctx.getPersonaDescription() || ''; } catch { /* fall through */ }
    }
    // Fallback: read manually via ctx.powerUserSettings + personas.js's user_avatar.
    // From src/generator.js the relative path to public/scripts/personas.js is
    //   ../../../../personas.js  (4 ../ hops: src → Glosses → third-party → extensions → scripts)
    try {
        if (!_userAvatarImport) {
            _userAvatarImport = import('../../../../personas.js').catch(() => null);
        }
        const mod = await _userAvatarImport;
        const user_avatar = mod?.user_avatar;
        const pu = ctx.powerUserSettings;
        if (user_avatar && pu?.persona_descriptions) {
            const desc = pu.persona_descriptions?.[user_avatar]?.description;
            if (typeof desc === 'string') return desc;
        }
    } catch { /* non-critical */ }
    return '';
}

/**
 * @param {string} messageId
 * @param {number} swipeIdx
 * @param {{ skipForbidden?: boolean }} [opts] — skipForbidden drops the
 *        [Forbidden anchors] block. Used by the targeted flow, whose targets
 *        are explicit user choices that must not be second-guessed by the
 *        stop-words / forced-ignore lists.
 */
export async function buildContextBlocks(messageId, swipeIdx, opts = {}) {
    const ctx = getCtx();
    const s = S();
    const msg = ctx.chat?.[parseInt(messageId)];
    if (!msg) return [];
    const text = Array.isArray(msg.swipes) ? (msg.swipes[swipeIdx] ?? msg.mes) : msg.mes;
    const cleanText = extractPlainText(text);
    const parts = [`[Annotate this post:\n${cleanText}]`];

    if (s.avoidRepeatedAnchors !== false) {
        // "Already explained" pool: permissive — every anchor Glosses has ever
        // generated for this chat (any message, any variant), except the
        // current message's own anchors, so the block can't leak a hint to
        // re-gloss exactly the target. Those filters deliberately do NOT
        // filter by swipe/position/message-type: in chats with swipes or
        // regenerations those filters silently dropped most of the pool,
        // leaving the advisory block empty. See collectExplainedAnchors.
        const prior = collectExplainedAnchors({
            sets: listFootnoteSets(),
            currentMsgId: messageId,
            limit: 200,
            // Per-chat "hidden from advisory" list, curated from the pool-manager
            // UI in the Exclusions tab. Hides an anchor from THIS block only —
            // the footnote itself is unaffected.
            excludeKeys: getPoolExcluded(),
        });
        if (prior.length) {
            parts.push(`[Previously glossed anchors - prefer different anchors when possible; reuse is allowed to reach the requested count:\n${prior.join('; ')}]`);
        }
    }

    if (s.contextDepth > 0) {
        const history = buildChatHistory(messageId);
        if (history) parts.push(`[Earlier in the scene — reference only; do NOT annotate it, use it only as background:\n${history}]`);
    }
    if (s.includeCharacterCard) {
        const card = buildCharBlock(messageId);
        if (card) parts.push(card);
    }
    if (s.includePersona) {
        const persona = await getPersonaDescription();
        if (persona) parts.push(`[User persona:\n${persona}]`);
    }
    // ── Lorebook context. Effective source, in order:
    //   1. per-chat config (chatMetadata.gls_lorebook, lorebooks.js) when its
    //      enabled flag is on — AUTOMATIC scope ALL (dry-run scan + vectorized
    //      entries from the WORLD_INFO_ACTIVATED cache) or ATTACHED (only the
    //      entries of books bound to this chat), or MANUAL (user-picked
    //      entries via resolveManualLore). Cache miss in ATTACHED → empty:
    //      there is NO degradation to the full scan, because that path cannot
    //      exclude global-panel books and would break the attached-only
    //      contract (aligned with DS Comments).
    //   2. otherwise the legacy global includeLorebook toggle → full scan.
    // isDryRun is ALWAYS true in every scan (contract ported from DS
    // Comments): a non-dry-run scan re-emits WORLD_INFO_ACTIVATED and writes
    // sticky/cooldown timed-effects into chat_metadata OUTSIDE ST's
    // generation cycle — the footnote prompt must neither consume nor mutate
    // the main chat's world-info state.
    const loreCfg = getChatLoreConfig(ctx);
    if (loreCfg.enabled || s.includeLorebook) {
        let wi = '';
        try {
            if (loreCfg.enabled && loreCfg.mode === LORE_MODE.MANUAL) {
                const lore = await resolveManualLore(ctx, loreCfg.selectedEntries);
                wi = lore.text;
            } else if (loreCfg.enabled) {
                const { chatMessages, globalScanData } = buildLoreScanInput(ctx);
                const scope = loreCfg.autoScope ?? LORE_SCOPE.ALL;
                const lore = await collectAutomaticLore(ctx, { chatMessages, globalScanData, anchorMsgId: messageId, anchorSwipeIdx: swipeIdx, scope });
                wi = lore.text;
            } else {
                const { chatMessages, globalScanData } = buildLoreScanInput(ctx);
                const wiResult = ctx.getWorldInfoPrompt?.(chatMessages, LORE_SCAN_MAX_CONTEXT, true, globalScanData);
                wi = coercePromptText(wiResult instanceof Promise ? await wiResult : wiResult);
            }
        } catch { /* WI unavailable */ }
        if (wi) parts.push(`[World info — background only. Do NOT annotate it:
${wi}]`);
    }

    if (!opts.skipForbidden) {
        const stopList = (s.stopWords || '').split(',').map(x => x.trim()).filter(Boolean);
        const forbidden = combineForbiddenAnchors(stopList, getForcedIgnore());
        if (forbidden.length) parts.push(`[Forbidden anchors — do NOT create footnotes for these exact phrases:\n${forbidden.join('; ')}]`);
    }

    return parts;
}
