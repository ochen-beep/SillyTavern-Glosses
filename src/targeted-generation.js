// @ts-check
/**
 * Targeted, list-driven footnote generation («Точечно» tab).
 *
 * The MODEL-side half stays transient (parse + validate against the submitted
 * targets); the PERSISTENCE half (anchoring + saveTargeted) lives in the tab
 * flow in src/ui/window.js, which resolves each target against the focused
 * variant's text and commits through the normal payload store.
 */
import { parseResponse } from './parser.js';
import { normalizeAnchorKey } from './anchor-utils.js';
import { S, beginGenerationEpoch, isEpochCurrent, t } from './core.js';
import { rebindTargeted } from './domain/rebind.js';

const MAX_TARGETS = 20;
const keyOf = normalizeAnchorKey;

/**
 * Resolve fresh targeted entries against a variant's plain text: exact
 * normalized match → fuzzy rescue; a miss leaves the entry FLOATING (no
 * prefix/suffix selectors — rendered without a marker, badged in the panel).
 * Delegates to rebindTargeted so generation and edit-rebind share ONE
 * resolution policy.
 *
 * @param {Array<{anchor:string, text:string}>} entries
 * @param {string} plainText
 * @returns {Array<{index:number, anchor:string, text:string, prefix?:string, suffix?:string}>}
 */
export function resolveTargetedAnchors(entries, plainText) {
    return rebindTargeted(entries, plainText).targeted;
}

export function parseTargetLines(text, limit = MAX_TARGETS) {
    const targets = [];
    const seen = new Set();
    let duplicateCount = 0;
    let truncatedCount = 0;
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const target = raw.trim();
        if (!target) continue;
        const key = keyOf(target);
        if (seen.has(key)) { duplicateCount++; continue; }
        if (targets.length >= limit) { truncatedCount++; continue; }
        seen.add(key);
        targets.push(target);
    }
    return { targets, duplicateCount, truncatedCount };
}

function footnoteText(value) {
    const text = String(value ?? '').trim();
    return text ? text.replace(/^[⁰¹²³⁴⁵⁶⁷⁸⁹\d]+\s*/u, '') : '';
}

export function validateTargetedResponse(parsed, targets) {
    const orderedTargets = Array.isArray(targets) ? targets : parseTargetLines(targets).targets;
    const byKey = new Map(orderedTargets.map(target => [keyOf(target), target]));
    const used = new Set();
    const accepted = [];
    let invalidCount = 0;
    const source = Array.isArray(parsed) ? parsed : parsed?.footnotes;
    for (const candidate of source || []) {
        if (!candidate || typeof candidate !== 'object') { invalidCount++; continue; }
        const key = keyOf(candidate.anchor);
        const target = byKey.get(key);
        const text = footnoteText(candidate.text);
        if (!target || used.has(key) || !text) { invalidCount++; continue; }
        used.add(key);
        accepted.push({ anchor: target, text: candidate.text });
    }
    const footnotes = orderedTargets.filter(target => used.has(keyOf(target))).map((target, index) => {
        const found = accepted.find(fn => keyOf(fn.anchor) === keyOf(target));
        // Body WITHOUT a numeric prefix — targeted entries are marked by a
        // symbol derived from their position at render time, never by digits.
        return { ...found, index: index + 1, text: footnoteText(found.text) };
    });
    return {
        footnotes,
        missingTargets: orderedTargets.filter(target => !used.has(keyOf(target))),
        invalidCount,
    };
}

export function buildTargetedPrompt({ targets, style = '', outputLanguage = '', context = '' } = {}) {
    const list = (targets || []).map((target, i) => `${i + 1}. ${target}`).join('\n');
    return `[Targeted footnotes]\nGenerate exactly one footnote for each submitted target, in the same order.\n` +
        `Targets are authoritative and need not occur in the chat post. Do not add, merge, or rename targets.\n` +
        `Return only JSON: {"footnotes":[{"anchor":"submitted target","text":"Label (cat.) — explanation"}]}\n` +
        (outputLanguage ? `[Output language: ${outputLanguage}]\n` : '') +
        (style ? `[Style]\n${style}\n` : '') +
        (context ? `[Reference context]\n${context}\n` : '') + `[Submitted targets]\n${list}`;
}

/**
 * Short system prompt for targeted runs. Deliberately NOT the regular
 * BASE_SYSTEM_PROMPT ("create footnotes for that exact post" / "annotate the
 * target only") — those instructions directly contradict the targeted
 * contract, where the submitted targets are authoritative and may be absent
 * from the post.
 */
const TARGETED_SYSTEM_PROMPT = `You are ABfootnote, a footnote writing utility.
The user submits an explicit list of target phrases. Write exactly one footnote for each submitted target, in the submitted order, in the requested output language.
Targets are authoritative user choices: they need not occur in the chat post; never add, merge, rename, or invent targets.
Never continue the scene. Never write narrative prose. Return only the requested JSON.`;

let activeRun = null;
let requestOverride = null;

export function setTargetedRequest(fn) { requestOverride = typeof fn === 'function' ? fn : null; }
export function clearTargetedState() {
    if (activeRun) activeRun.controller.abort();
    activeRun = null;
}

/**
 * @param {{targets: string[], messageId?: string|number, swipeIdx?: number, signal?: AbortSignal,
 *   systemPrompt?: string, userPrompt?: string, request?: Function, epoch?: number}} options
 */
export async function generateTargetedFootnotes(options = {}) {
    const targets = parseTargetLines(options.targets || '').targets;
    if (!targets.length) return { footnotes: [], missingTargets: [], invalidCount: 0, targets };
    clearTargetedState();
    const controller = new AbortController();
    const epoch = options.epoch ?? beginGenerationEpoch();
    const run = { controller, epoch };
    activeRun = run;
    if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
        const request = options.request || requestOverride || (async (system, user, signal) => {
            const s = S();
            if (s.source === 'profile') {
                const { generateWithProfile } = await import('./connection.js');
                return generateWithProfile(s.selectedProfile, system, user, signal);
            }
            if (s.source === 'custom') {
                const { generateWithCustomEndpoint } = await import('./connection.js');
                return generateWithCustomEndpoint(system, user, signal, s.customEndpoint, s.customModel);
            }
            throw new Error(t('Select a generation source (Connection Profile or Custom) in Glosses settings.'));
        });
        const prompt = options.userPrompt || buildTargetedPrompt({ targets, style: options.style, outputLanguage: options.outputLanguage, context: options.context });
        const raw = await request(options.systemPrompt || TARGETED_SYSTEM_PROMPT, prompt, controller.signal, options);
        if (activeRun !== run || controller.signal.aborted || !isEpochCurrent(epoch)) {
            return { stale: true, targets, footnotes: [], missingTargets: targets, invalidCount: 0 };
        }
        return { ...validateTargetedResponse(parseResponse(raw), targets), targets };
    } finally {
        if (activeRun === run) activeRun = null;
    }
}

export const _test = { keyOf, footnoteText };
