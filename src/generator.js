// @ts-check
/**
 * Glosses — Generator module
 * System/user prompt assembly, API calls, generation orchestration.
 *
 * Direct single-call generation: one API request returns up to N footnotes.
 * The model produces a {"footnotes":[...]} response; no candidate pool,
 * no reserve, no second request, no fill-loop. Prior anchors are supplied
 * as a soft advisory only; forced exclusions are strictly enforced.
 *
 * The PROMPT_EXAMPLES, BASE_SYSTEM_PROMPT blocks and the loadPromptStyle/
 * interpolateLangPrompt logic are unchanged from the original.
 */

import {
    state, S, getCtx, getExtBase, warn, error, extractPlainText, t,
    DEFAULT_SETTINGS, MAX_FOOTNOTES_CAP, HYBRID_BUILTIN_LENSES,
} from './core.js';
import { PROMPT_EXAMPLES } from './prompt-examples.js';
import { buildContextBlocks } from './context-blocks.js';
import { FOOTNOTE_CONTRACT } from './prompt-contract.js';
import {
    digestFor, variantIsViable, saveFootnotes, getForcedIgnore,
} from './cache.js';
import { isTranslatedView } from './domain/message-identity.js';
import { combineForbiddenAnchors } from './anchor-policy.js';
import { findAnchorInText } from './anchor-utils.js';
import { buildTextIndex, computeContextSelectors, findFuzzySpan } from './text-index.js';
import { parseResponse, validateFootnotes, validateFootnotesAgainstText, normalizeFootnotes } from './parser.js';
import { injectHighlights, setSpinner } from './renderer.js';
import { updatePanel, panelInvalidate } from './ui/window.js';
import { uiBusyBegin, uiBusyEnd } from './ui/busy.js';
import { playSound } from './sound.js';
import { generationCoordinator } from './application/generation-coordinator.js';
import { renumberFootnotes } from './application/footnote-commands.js';
import { generateWithConfiguredSource } from './connection.js';

// ══════════════════════════════════════════════════════════════════════════════
// BASE SYSTEM PROMPTS
// ══════════════════════════════════════════════════════════════════════════════

const BASE_SYSTEM_PROMPT = `You are ABfootnote, a deterministic footnote extraction utility for SillyTavern.
Your task is NOT roleplay, NOT chat continuation, NOT creative writing.
Read the provided [Annotate this post] block and create footnotes for that exact post.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks ([Earlier in the scene], character, world info) are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

const BASE_SYSTEM_PROMPT_LANG = `You are ABfootnote — a language-learning footnote generator for SillyTavern.
For every interesting word or phrase in [Annotate this post], output a footnote that teaches its translation to the target language.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

// Constructed / fictional target languages. When the target is in this set,
// {{CONLANG_NOTE}} is expanded into an attestation-honesty nudge in language.md.
// Esperanto (`eo`) and Toki Pona (`tok`) are real but constructed — the note
// still applies (it asks for canonically attested forms, not invented ones).
const CONLANG_CODES = new Set(['hvl', 'tlh', 'sin', 'quen', 'eo', 'tok']);

// Body of the {{CONLANG_NOTE}} block, embedded into language.md. Contains a
// {{TARGET_LANG_NAME}} token so it must be substituted BEFORE that placeholder
// is expanded in interpolateLangPrompt.
const CONLANG_NOTE_BODY = `### Attestation note (constructed / fictional target)
The target language {{TARGET_LANG_NAME}} is a constructed or fictional
language. Use only canonically attested words and IPA transcriptions — do not
invent vocabulary. If a translation must be reconstructed from attested roots,
explicitly mark it with "(reconstructed)". If the phonology of a word is
unattested, state that plainly instead of inventing IPA.`;

// Hybrid footnote mode: several lenses are active at once. The model picks the
// ONE best-fitting lens per anchor and produces exactly one footnote for it;
// the category label reveals which lens won. See spec
// 2026-07-02-glosses-hybrid-mode-design.md.
const BASE_SYSTEM_PROMPT_HYBRID = `You are ABfootnote — a hybrid footnote generator for SillyTavern.
For each interesting word, phrase, or situation in [Annotate this post], select the ONE lens that best fits it and apply ONLY that lens's format to produce exactly one footnote for that anchor. The category label in parentheses reveals which lens you chose. Never produce two footnotes for the same anchor.
Never continue the scene. Never write narrative prose. Never imitate the character.

## SCENE FOCUS
The [Annotate this post] block is the post you annotate — your ONLY target. All other blocks are background that helps you understand the target. Use the background to understand the target; annotate the target only.

Follow the [ANNOTATOR CONTRACT] in the user message exactly for the JSON schema, count, anchor format, and footnote structure.`;

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT STYLE LOADING
// ══════════════════════════════════════════════════════════════════════════════

// The output language of footnote TEXT (not the UI language, not the study
// target). Set via the "Output language" dropdown; default 'ru'. This replaces
// the old heuristic (document.documentElement.lang) which inferred it from the
// ST UI language — see anchor-count-language spec §3.
export function getOutputLanguage() {
    return S().outputLanguage === 'en' ? 'English' : 'Russian';
}

// Boolean convenience mirroring getOutputLanguage, used by label tables.
function isOutputRu() {
    return S().outputLanguage !== 'en';
}

function langCacheKey() {
    const s = S();
    return `${s.targetLanguage || 'en'}:${s.cefrLevel || 'auto'}:${getOutputLanguage()}`;
}

/** Drop every cached prompt whose key starts with the prefix (style/lang/
 *  hybrid signature changed → stale entries). */
function invalidatePromptCache(prefix) {
    for (const k of Object.keys(state.promptCache)) {
        if (k.startsWith(prefix)) delete state.promptCache[k];
    }
}

/**
 * Assemble the STYLE half of the prompt (style rules + few-shot examples) for
 * the current promptStyle + output language, WITHOUT the base system prompt.
 * Cached per key. The targeted flow («Точечно») uses this alone — the regular
 * BASE_SYSTEM_PROMPT contradicts the targeted contract (authoritative targets
 * need not occur in the post).
 */
export async function assembleStyle() {
    const s = S();
    const outputLang = getOutputLanguage();
    const examplesLocale = outputLang === 'Russian' ? 'ru' : 'en';
    let stylePrompt = '';

    if (s.promptStyle === 'custom') {
        stylePrompt = s.customPrompt || '';
    } else if (s.promptStyle === 'language') {
        const key = `language:${langCacheKey()}`;
        if (state.promptCache[key]) {
            stylePrompt = state.promptCache[key];
        } else {
            // Invalidate any stale language caches (settings changed).
            invalidatePromptCache('language:');
            try {
                const resp = await fetch(`${getExtBase()}/prompts/language.md`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                let raw = await resp.text();
                raw = interpolateLangPrompt(raw);
                const examples = PROMPT_EXAMPLES.language?.[examplesLocale] || '';
                raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);
                stylePrompt = raw;
                state.promptCache[key] = stylePrompt;
            } catch (e) { warn('Failed to load language prompt:', e); }
        }
    } else if (s.promptStyle === 'hybrid') {
        // Hybrid mode: one footnote per anchor, the model picks the single
        // best-fitting ACTIVE LENS. The envelope (prompts/hybrid.md) carries the
        // COMMON rules (output language, translation boundary, format) ONCE; each
        // active lens contributes only its own role (voice + when + label).
        // Custom lenses (user-authored) travel alongside the 6 built-ins, so the
        // constructor accepts any mix.
        //
        // Cache key is built from (a) the active built-in lens names + (b) the
        // active custom lens ids + (c) lang/cefr/outputLang signature, so any
        // flip / add / edit / delete of a custom lens invalidates it.
        stylePrompt = await _buildHybridPrompt(examplesLocale, outputLang);
    } else {
        const style = s.promptStyle || 'pratchett';
        const key = `${style}:${outputLang}`;
        if (state.promptCache[key]) {
            stylePrompt = state.promptCache[key];
        } else {
            invalidatePromptCache(`${style}:`);
            try {
                const resp = await fetch(`${getExtBase()}/prompts/${style}.md`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                let raw = await resp.text();
                raw = raw.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
                // Contract/vibe split: the shared format rules were moved OUT of
                // the style files into src/prompt-contract.js (they were
                // duplicated verbatim in every style). The {{CONTRACT}} marker
                // sits where the per-style "### Format requirements" section
                // used to be, so the assembled prompt is unchanged.
                raw = raw.replace(/\{\{CONTRACT\}\}/g, FOOTNOTE_CONTRACT);
                const examples = PROMPT_EXAMPLES[style]?.[examplesLocale] || '';
                raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);
                stylePrompt = raw;
                state.promptCache[key] = stylePrompt;
            } catch (e) { warn('Failed to load prompt style:', e); }
        }
    }

    // The style half is complete; the base system prompt is appended by
    // loadPromptStyle for the regular flow only.
    return (stylePrompt || '').trim();
}

/**
 * Full system prompt for the REGULAR flow: base SCENE-FOCUS prompt (what to
 * annotate) + the style half. The count target + VERBATIM contract live in
 * buildUserPrompt's user message. The system prompt carries no count pressure
 * here, so the model is never forced to fabricate anchors; the user-message
 * contract tells it to broaden anchor granularity (names/phrases/clauses) to
 * reach N honestly in one request.
 */
export async function loadPromptStyle() {
    const s = S();
    const stylePrompt = await assembleStyle();
    const basePrompt = s.promptStyle === 'language' ? BASE_SYSTEM_PROMPT_LANG
        : s.promptStyle === 'hybrid'    ? BASE_SYSTEM_PROMPT_HYBRID
        : BASE_SYSTEM_PROMPT;
    return `${basePrompt}\n\n${stylePrompt || ''}`.trim();
}

function interpolateLangPrompt(template) {
    const LANG_NAMES = {
        en: 'English', fr: 'Français', de: 'Deutsch', es: 'Español',
        it: 'Italiano', pt: 'Português', ja: 'Japanese', ko: 'Korean',
        zh: 'Chinese', tr: 'Türkçe', pl: 'Polski', nl: 'Nederlands',
        // Constructed / fictional (see CONLANG_CODES)
        hvl: 'High Valyrian', tlh: 'Klingon', sin: 'Sindarin',
        quen: 'Quenya', eo: 'Esperanto', tok: 'Toki Pona',
    };
    const isRu = isOutputRu();
    const LANG_LABELS = isRu ? {
        en: 'англ.', fr: 'фр.', de: 'нем.', es: 'исп.',
        it: 'ит.', pt: 'порт.', ja: 'яп.', ko: 'кор.',
        zh: 'кит.', tr: 'тур.', pl: 'польск.', nl: 'нид.',
        // Constructed / fictional
        hvl: 'вал.', tlh: 'клн.', sin: 'синд.',
        quen: 'квэн.', eo: 'эсп.', tok: 'токи',
    } : {
        en: 'Eng.', fr: 'Fr.', de: 'Ger.', es: 'Sp.',
        it: 'It.', pt: 'Port.', ja: 'Jap.', ko: 'Kor.',
        zh: 'Chi.', tr: 'Tur.', pl: 'Pol.', nl: 'Dut.',
        // Constructed / fictional
        hvl: 'Val.', tlh: 'Kli.', sin: 'Sind.',
        quen: 'Quen.', eo: 'Esp.', tok: 'Tok.',
    };
    const CEFR_DESC = {
        auto: 'Adapt to the text\'s complexity automatically. Select words appropriate for the reader\'s likely level. Focus on instructive, non-obvious translations.',
        a1a2: 'Focus on A1–B1 vocabulary. Simple, everyday words. Use short, clear explanations. Prioritize survival words and basic phrases.',
        b1b2: 'Focus on B1–C1 vocabulary. Explain idioms, phrasal verbs, collocations, nuanced usage. Highlight differences between literal and figurative meaning.',
        c1c2: 'Focus on C1–C2 vocabulary. Literary terms, etymology, stylistic nuances, rare constructions. Include word origins and register information.',
    };
    const lang = S().targetLanguage || 'en';
    const level = S().cefrLevel || 'auto';
    const outputLang = isRu ? 'Russian' : 'English';
    // Conlang attestation note — substituted first so its own
    // {{TARGET_LANG_NAME}} token is expanded by the next replace.
    const conlangNote = CONLANG_CODES.has(lang) ? CONLANG_NOTE_BODY : '';
    return template
        .replace(/\{\{CONLANG_NOTE\}\}/g, conlangNote)
        .replace(/\{\{TARGET_LANG_NAME\}\}/g, LANG_NAMES[lang] || lang)
        .replace(/\{\{TARGET_LANG_CODE\}\}/g, lang)
        .replace(/\{\{TARGET_LANG_LABEL\}\}/g, LANG_LABELS[lang] || `${lang}.`)
        .replace(/\{\{CEFR_LEVEL\}\}/g, level)
        .replace(/\{\{CEFR_LEVEL_DESC\}\}/g, CEFR_DESC[level] || CEFR_DESC.auto)
        .replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
}

/**
 * Snapshot a built-in lens's raw template for "copy to custom lenses".
 * The language lens's {{TARGET_LANG_*}}/{{CEFR_*}}/{{CONLANG_NOTE}} tokens are
 * BAKED with the current settings — the custom-lens build path never runs the
 * language interpolation — while {{OUTPUT_LANGUAGE}} stays raw because the
 * custom path substitutes it at generation time (generator _buildHybridPrompt).
 */
export function bakeLensCopyText(lensId, rawTemplate) {
    const raw = String(rawTemplate ?? '');
    return lensId === 'language' ? interpolateLangPrompt(raw) : raw;
}

// ── Hybrid prompt assembly ──────────────────────────────────────────────────
// The envelope (prompts/hybrid.md) carries the COMMON rules ONCE; each active
// lens contributes only its role. Custom lenses (user-authored) travel inline.
// One footnote per anchor: the model picks the single best-fitting ACTIVE LENS.

/**
 * Resolve the active lens flags using DEFAULT_SETTINGS as the single source
 * of truth for missing/non-boolean values (spec §5.3). Replaces the old
 * mixed `!== false` / `=== true` ad-hoc guards in `_buildHybridPrompt`
 * that were fragile to future lens additions.
 *
 * @param {object} lenses  - S().hybridLenses (may be missing or partial)
 * @param {object} defaults - DEFAULT_SETTINGS.hybridLenses
 * @returns {Object<string, boolean>}
 */
function resolveActiveLenses(lenses, defaults) {
    const src = (lenses && typeof lenses === 'object') ? lenses : {};
    const out = {};
    for (const k of HYBRID_BUILTIN_LENSES) {
        const v = src[k];
        out[k] = (typeof v === 'boolean') ? v : defaults[k];
    }
    return out;
}

async function _buildHybridPrompt(examplesLocale, outputLang) {
    const s = S();
    const lenses = s.hybridLenses || {};
    const active = resolveActiveLenses(lenses, DEFAULT_SETTINGS.hybridLenses);
    // Custom lenses: active, with a name AND a non-empty prompt body.
    const customActive = (Array.isArray(s.customLenses) ? s.customLenses : [])
        .filter(c => c && c.active && c.name && c.prompt);

    // Defensive: if EVERYTHING is off (only possible via hand-edit), force
    // Language on so the model always has at least one lens.
    const anyBuiltin = HYBRID_BUILTIN_LENSES.some(k => active[k]);
    if (!anyBuiltin && !customActive.length) active.language = true;

    const overrides = s.builtinLensOverrides || {};
    // An overridden lens is marked in the cache signature (`name*`) so ADDING
    // or REMOVING an override produces a new key; EDITING an override's text
    // relies on settings-sync's _invalidateLanguageCache (same contract as
    // custom-lens text edits).
    const sig = [
        ...HYBRID_BUILTIN_LENSES.filter(k => active[k]).map(k => String(overrides[k] || '').trim() ? `${k}*` : k),
        ...customActive.map(c => c.id || c.name),
    ].join(',');
    const key = `hybrid:${sig}:${langCacheKey()}`;
    if (state.promptCache[key]) return state.promptCache[key];

    // Invalidate stale hybrid prompts (active lens set / lang changed).
    invalidatePromptCache('hybrid:');

    let raw = '';
    try {
        const resp = await fetch(`${getExtBase()}/prompts/hybrid.md`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} (hybrid.md)`);
        raw = await resp.text();
    } catch (e) {
        warn('Failed to load hybrid envelope:', e);
        return '';
    }

    // Build the {{LENSES}} body: one block per active lens, built-ins first
    // (fixed order), then custom (stored order). One footnote per anchor means
    // the model SEES all active lenses and picks one per anchor — no overlap.
    const blocks = [];
    for (const lens of HYBRID_BUILTIN_LENSES) {
        if (!active[lens]) continue;
        try {
            // User override wins over the bundled template. The language
            // lens's tokens interpolate identically for overrides and disk
            // templates (see interpolateLangPrompt below).
            let snip = String(overrides[lens] || '').trim();
            if (!snip) {
                const snipResp = await fetch(`${getExtBase()}/prompts/lenses/${lens}.md`);
                if (!snipResp.ok) throw new Error(`HTTP ${snipResp.status} (lenses/${lens}.md)`);
                snip = await snipResp.text();
            }
            // Language lens needs {{TARGET_LANG_*}} + {{CEFR_*}} + {{CONLANG_NOTE}}
            // interpolated BEFORE {{OUTPUT_LANGUAGE}} is applied. interpolateLangPrompt
            // handles OUTPUT_LANGUAGE too, so it's a single pass for that lens.
            snip = lens === 'language' ? interpolateLangPrompt(snip)
                                       : snip.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
            blocks.push(snip.trim());
        } catch (e) {
            warn(`Failed to load hybrid lens "${lens}":`, e);
            // Skip the missing lens rather than nuking the whole prompt — a
            // packaging bug on ONE lens shouldn't blank the other five.
        }
    }
    for (const c of customActive) {
        // Custom lenses only get {{OUTPUT_LANGUAGE}} (no lang/CEFR tokens).
        const body = String(c.prompt).replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);
        blocks.push(`### Lens: ${String(c.name).trim()}\n${body.trim()}`);
    }

    raw = raw.replace(/\{\{LENSES\}\}/g, blocks.join('\n\n'));

    // Few-shot examples: {{TARGET_LANG_LABEL}} only makes sense if the Language
    // lens is on (the first example footnote is a language-lens example).
    // interpolateLangPrompt handles the label cleanly; otherwise strip it.
    let examples = PROMPT_EXAMPLES.hybrid?.[examplesLocale] || '';
    if (active.language) examples = interpolateLangPrompt(examples);
    else                 examples = examples.replace(/\{\{TARGET_LANG_LABEL\}\}/g, '');
    raw = raw.replace(/\{\{EXAMPLES\}\}/g, examples);

    // Final envelope pass: hybrid.md's own {{OUTPUT_LANGUAGE}} (the lens
    // snippets above did their own replace, so this is a no-op for them).
    raw = raw.replace(/\{\{OUTPUT_LANGUAGE\}\}/g, outputLang);

    state.promptCache[key] = raw;
    return raw;
}

// ══════════════════════════════════════════════════════════════════════════════
// USER PROMPT BUILDING
// ══════════════════════════════════════════════════════════════════════════════


// Shared tail of both contracts: forbidden-list rule + output schema (F3 —
// one place to edit the JSON shape; previously drifted between two copies).
const _CONTRACT_TAIL = `Do not create anchors matching the forbidden list. For an oblique source form, keep the exact source phrase in "anchor" and use the nominative only as the display label in "text".

Output ONLY this JSON (no markdown fences, no prose):
{"footnotes":[{"anchor":"verbatim source phrase","text":"¹ Label (cat.) — explanation"}]}`;

export const DIRECT_FOOTNOTE_CONTRACT = `[ANNOTATOR CONTRACT — direct footnotes, one response]

Generate exactly {N} distinct footnotes. Return fewer only when the post genuinely cannot support that many. Never invent or borrow anchors from background blocks.

Scan the entire [Annotate this post] block: foreign/archaic terms, specialized vocabulary, proper nouns, place names, titles of works, idioms, metaphors, and verbatim clauses describing a meaningful situation. Each "anchor" MUST be an exact verbatim substring of [Annotate this post] and distinct from every other anchor; quote the visible wording only — never include markdown decoration characters (*, _, \`, ~) in the anchor. If a [Previously glossed anchors] block is provided below, prefer anchors not listed there when possible; reuse is allowed to reach {N}.

${_CONTRACT_TAIL}`;

// Auto-count variant: no N pressure. Everything else (verbatim anchors,
// forbidden list, JSON-only output) is identical to the fixed contract.
export const DIRECT_FOOTNOTE_CONTRACT_AUTO = `[ANNOTATOR CONTRACT — direct footnotes, one response]

Decide yourself how many footnotes this post deserves: annotate every anchor in [Annotate this post] that a curious reader would genuinely want explained — foreign/archaic terms, specialized vocabulary, proper nouns, place names, titles of works, idioms, metaphors, and verbatim clauses describing a meaningful situation. Spread the footnotes across the whole post instead of clustering in the opening. Never pad the list with weak or duplicate anchors; an honest small set beats an inflated one. Each "anchor" MUST be an exact verbatim substring of [Annotate this post] and distinct from every other anchor; quote the visible wording only — never include markdown decoration characters (*, _, \`, ~) in the anchor. If a [Previously glossed anchors] block is provided below, prefer anchors not listed there when possible.

${_CONTRACT_TAIL}`;

function getTargetFootnoteCount() {
    const n = parseInt(S().maxFootnotes, 10);
    return Number.isFinite(n) ? Math.min(MAX_FOOTNOTES_CAP, Math.max(1, n)) : 5;
}

/** True when the model (not the numeric setting) decides the footnote count. */
export function isAutoFootnoteCount() {
    return S().autoFootnoteCount === true;
}

/** Build the direct user-turn prompt with target, contract, then reference blocks. */
export async function buildUserPrompt(messageId, swipeIdx) {
    const parts = await buildContextBlocks(messageId, swipeIdx);
    if (!parts.length) return '';
    const contract = isAutoFootnoteCount()
        ? DIRECT_FOOTNOTE_CONTRACT_AUTO
        : DIRECT_FOOTNOTE_CONTRACT.replace(/\{N\}/g, String(getTargetFootnoteCount()));
    return [parts[0], contract, ...parts.slice(1)].join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the DOM text model for a message element's rendered .mes_text.
 * Returns null when the element or the DOM API is unavailable (Node tests,
 * detached elements) so the caller can fall back to the prompt text. Safe to
 * call while the PREVIOUS generation's highlights are still on screen: the
 * index excludes superscript digits (sup.gls-sup) and .gls-marker wrappers
 * add no text, so the model equals the one built over the clean DOM.
 */
function buildDomTextModel(mesEl) {
    try {
        if (!mesEl || typeof mesEl.querySelector !== 'function') return null;
        const mesText = mesEl.querySelector('.mes_text');
        if (!mesText) return null;
        return buildTextIndex(mesText);
    } catch {
        return null;
    }
}

/**
 * Generate footnotes for a message+swipe, persist them, and inject highlights.
 * Aborts a previous in-flight generation for the same messageId.
 *
 * Direct generation makes one API request and validates exact target-post
 * anchors before transactional persistence. When the rendered DOM is
 * available, validation runs against the SAME text index the renderer will
 * match on (with a fuzzy second tier for lightly normalized anchors), so a
 * validated footnote is a footnote that can physically receive a marker.
 * Overshoot is capped in document order; an honest undershoot is retained.
 *
 * The variant's identity is its full-text digest, snapshotted at run start:
 * the commit guard discards the result when the variant was switched or its
 * text changed (edit / continue) while the request was in flight.
 */
// Launcher pulse + panel progress bar: while any generation is in flight, both
// launcher controls (QR-bar button + floating FAB) pulse via .gls_generating
// (style.css) and the floating panel sweeps its top progress bar. Generations
// are per-message and can overlap (a regen on another message) — and targeted
// runs overlap them too — so the class is owned by the shared refcounted
// uiBusyBegin/uiBusyEnd pair; superseded runs release too — their finally
// still runs after beginRun() replaced their controller.

export async function generateFootnotes(messageId, swipeIdx, mesEl, { auto = false } = {}) {
    // Translate-guard (manual paths included): regenerating over a translated
    // view would validate anchors against the translation but stamp the
    // payload with the ORIGINAL body's digest — markers land on translation
    // words and misplace after un-translate. Ask the user to un-translate.
    const entryMsg = getCtx().chat?.[parseInt(messageId)];
    if (isTranslatedView(entryMsg)) {
        globalThis.toastr?.info?.(`[Glosses] ${t('The message is translated — un-translate it to regenerate footnotes.')}`);
        return;
    }
    if (!variantIsViable(messageId, swipeIdx)) {
        // Reject placeholder/short posts at every entry point (Issue 5).
        return;
    }
    const startDigest = digestFor(messageId, swipeIdx);
    // Stage 6: the coordinator owns the per-message run (controller + token +
    // revision + chatEpoch). Starting a new run supersedes any previous one.
    // `auto` marks runs the autoGenerate toggle-off may abort (abortAutoRuns);
    // manual entry points (regen button, panel CTAs, /glosses_regen) stay immune.
    const run = generationCoordinator.beginRun(messageId, { auto });
    const ctrl = run.ctrl;
    setSpinner(messageId, true);
    uiBusyBegin();

    try {
        const signal = ctrl.signal;
        const systemPrompt = await loadPromptStyle();
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        // fixed-count mode only; unused by the auto-count path
        const target = getTargetFootnoteCount();
        const userPrompt = await buildUserPrompt(messageId, swipeIdx);
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        const stopList = (S().stopWords || '').split(',').map(x => x.trim()).filter(Boolean);
        const forbidden = combineForbiddenAnchors(stopList, getForcedIgnore());
        // Single source of truth: with a rendered element, validate against
        // the DOM text index (what the renderer matches). The fuzzy resolver
        // is the second tier for anchors the model lightly normalized —
        // inflections, markdown decoration — and every rescue is logged.
        const domModel = buildDomTextModel(mesEl);
        const validationText = domModel?.text ?? null;
        const resolveFallback = validationText === null ? null : (anchor) => {
            const hit = findFuzzySpan(validationText, anchor);
            if (hit) warn(`Fuzzy-resolved anchor "${anchor}" -> "${hit.text}" (distance ${hit.distance})`);
            return hit;
        };
        const parsed = parseResponse(await callAPI(systemPrompt, userPrompt, signal));
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        const validated = validationText !== null
            ? validateFootnotesAgainstText(parsed, validationText, forbidden, resolveFallback)
            : validateFootnotes(parsed, userPrompt, forbidden);
        if (!generationCoordinator.isCurrent(run)) return;   // chat switched / swiped / superseded
        if (!validated?.length) {
            // Not a silent no-op: the user cannot tell "the model returned
            // garbage" from "nothing in the post was worth glossing".
            const candidates = parsed?.footnotes?.length ?? 0;
            if (!candidates) {
                globalThis.toastr?.warning?.(`[Glosses] ${t('The model returned no parsable footnotes. Check the connection or try again.')}`);
            } else {
                globalThis.toastr?.info?.(`[Glosses] ${t('All returned footnote anchors were rejected (not found in the post, duplicates, or forced-ignore).')}`);
            }
            return;
        }

        const ctx2 = getCtx();
        const msg2 = ctx2.chat?.[parseInt(messageId)];
        const rawMes = Array.isArray(msg2?.swipes) ? (msg2.swipes[swipeIdx] ?? msg2.mes) : (msg2?.mes ?? '');
        const plain = extractPlainText(rawMes);
        let footnotes = normalizeFootnotes(validated, validationText ?? plain) ?? validated;
        // If the model overshoots N, keep the first N in document order and
        // renumber 1..N. Undershoot is left as-is (honest maximum). Auto-count
        // mode keeps every validated footnote the model returned.
        if (!isAutoFootnoteCount() && footnotes.length > target) {
            footnotes = footnotes.slice(0, target);
            footnotes = renumberFootnotes(footnotes);
        }
        if (!footnotes?.length) return;

        // The direct contract has no validation-only fields. Keep persisted
        // entries constrained to the renderer/cache footnote shape, plus the
        // context selectors (prefix/suffix around the resolved span) that let
        // re-injections prefer the occurrence each anchor was originally
        // placed on when the anchor string occurs multiple times. Floating
        // entries (anchor not in the post) ride along with their flag — no
        // selectors resolve for them.
        footnotes = footnotes.map((f) => {
            const out = { index: f.index, anchor: f.anchor, text: f.text };
            if (f.floating) out.floating = true;
            if (validationText !== null) {
                const hit = findAnchorInText(validationText, f.anchor);
                if (hit) Object.assign(out, computeContextSelectors(validationText, hit.start, hit.end));
            }
            return out;
        });

        // Final guard right before the irreversible write: the awaits above for
        // normalization are cheap, but a chat switch could still have landed in
        // the gap. Never persist/render into the wrong chat.
        // Stage 6: isCurrent(run) now also requires that THIS run is still the
        // owner of the message's abort slot — a superseded run whose transport
        // ignored AbortSignal can no longer commit over its replacement. The
        // live digest check is kept: an in-place edit or swipe can otherwise
        // retain ownership while changing the target text.
        const liveMsg = getCtx().chat?.[parseInt(messageId)];
        const liveSwipe = liveMsg?.swipe_id ?? 0;
        const liveDigest = digestFor(messageId, liveSwipe);
        if (!generationCoordinator.isCurrent(run) || liveSwipe !== swipeIdx || liveDigest !== startDigest) return;
        saveFootnotes(messageId, swipeIdx, footnotes, { style: S().promptStyle });
        // §6.4: a successful run (manual paths included) clears the sticky
        // "Source not configured" badge — previously only the auto-generate and
        // targeted paths reset it, so one failure kept the badge up forever and
        // hid the empty-state Generate CTA behind 'unconfigured'.
        state.configuredState = { ok: true, reason: '' };
        // The entry snapshot can go stale across the awaits: a host re-render
        // may replace the .mes node while text and digest stay equal. Re-resolve
        // so markers land in the live DOM, not a detached orphan.
        const liveMesEl = document.querySelector(`.mes[mesid="${messageId}"]`) || mesEl;
        injectHighlights(liveMesEl, footnotes);
        playSound();
        state.panelFocusMsgId = String(messageId);
        panelInvalidate();
        updatePanel();
    } catch (e) {
        if (e.name === 'AbortError') return;
        // A stale run is not an error — it was legitimately superseded by a chat
        // switch, a swipe of this message, or a newer run. Discard silently (no
        // toast, no configuredState flip).
        if (!generationCoordinator.isCurrent(run)) return;
        error(e);
        // §6.4: reflect any non-abort failure onto state.configuredState so the
        // floating panel can show the persistent badge — not just the momentary
        // toast. Manual /glosses_regen flows usually skip checkSourceConfigured,
        // so this catch is the only place they surface a failure into the panel.
        state.configuredState = { ok: false, reason: e.message || String(e) };
        globalThis.toastr?.error?.(`[Glosses] ${e.message}`);
    } finally {
        uiBusyEnd();
        // Only clean up if THIS call is still the active controller for the
        // message. If a later call (B) superseded us, its own finally cleans up;
        // touching state here would abort/hide B mid-flight. endRun guards on
        // ownership (abortControllers[id] === this run's ctrl).
        if (generationCoordinator.endRun(run)) {
            setSpinner(messageId, false);
            // §6.5: refresh the floating panel so the per-message regen button
            // (Task 18) and the persistent source badge (Task 16) un-lock /
            // re-render after a failure or abort, not just on success.
            try { updatePanel(); } catch { /* non-critical */ }
        }
    }
}

async function callAPI(systemPrompt, userPrompt, signal) {
    // Test-only injection point: tests set _testApiOverride to a function
    // returning a canned raw model response (possibly gated behind a promise
    // they control to simulate mid-flight chat switches). Gated on NODE_TEST
    // so production code never observes the hook.
    //
    // NOTE: read `process` via globalThis. The bare `process?.env` form throws
    // ReferenceError in the browser (process is a Node-only global that is not
    // even declared there — optional chaining guards against undefined VALUES,
    // not against undeclared identifiers). globalThis.process exists in Node
    // and is simply absent in the browser, so this short-circuits safely.
    if (globalThis.process?.env?.NODE_TEST === '1' && typeof _testApiOverride === 'function') {
        return _testApiOverride(systemPrompt, userPrompt, signal);
    }

    return generateWithConfiguredSource(systemPrompt, userPrompt, signal);
}

// ── Test-only hooks (gated on NODE_TEST) ──
// Set by tests/generation-epoch.test.mjs to intercept callAPI with a
// controllable promise so we can simulate a CHAT_CHANGED mid-flight.
let _testApiOverride = null;
export function _testSetApiOverride(fn) { _testApiOverride = fn; }
export function _testClearApiOverride() { _testApiOverride = null; }

