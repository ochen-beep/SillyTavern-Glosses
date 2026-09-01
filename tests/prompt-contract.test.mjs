import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Phase 4a test: contract/vibe split.
//
// The shared footnote format rules were moved OUT of the style .md files into
// src/prompt-contract.js (FOOTNOTE_CONTRACT), injected via the {{CONTRACT}}
// marker. Verifies:
//   1. The contract contains every critical format rule (anchor verbatim,
//      superscript index, nominative case, non-nominative rule, bracket ban).
//   2. No style file still duplicates those rules (no "### Format requirements").
//   3. Every style file carries the {{CONTRACT}} marker where the section used
//      to be, so the assembled prompt is unchanged for the model.

import './helpers/stub-runtime.mjs';
import { FOOTNOTE_CONTRACT } from '../src/prompt-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', 'prompts');

const STYLE_FILES = ['pratchett.md', 'pratchett50.md', 'academic.md', 'meta_plus.md'];

// ── 1. Contract completeness ──

test('FOOTNOTE_CONTRACT contains the anchor-verbatim rule', () => {
    assert.match(FOOTNOTE_CONTRACT, /"anchor" MUST be the exact verbatim phrase/);
});

test('FOOTNOTE_CONTRACT contains the superscript-index rule', () => {
    assert.match(FOOTNOTE_CONTRACT, /superscript digits/);
    assert.match(FOOTNOTE_CONTRACT, /¹, ², \.\.\., ⁹, ¹⁰, ¹¹, \.\.\./);
});

test('FOOTNOTE_CONTRACT contains the nominative-case rule', () => {
    assert.match(FOOTNOTE_CONTRACT, /nominative case/);
    assert.match(FOOTNOTE_CONTRACT, /благовониями/);   // the canonical oblique example
});

test('FOOTNOTE_CONTRACT contains the bracket-notation ban', () => {
    assert.match(FOOTNOTE_CONTRACT, /Do NOT put bracket notation in the "text" field/);
});

test('FOOTNOTE_CONTRACT contains the language-codes list', () => {
    assert.match(FOOTNOTE_CONTRACT, /\(It\.\), \(Fr\.\), \(Lat\.\)/);
});

test('FOOTNOTE_CONTRACT contains the spread-footnotes rule', () => {
    assert.match(FOOTNOTE_CONTRACT, /beginning, middle, and end/);
});

// ── 2. No duplication left in the style files ──

test('style files no longer contain a "### Format requirements" section', () => {
    for (const f of STYLE_FILES) {
        const src = readFileSync(join(promptsDir, f), 'utf8');
        assert.ok(!src.includes('### Format requirements'),
            `${f} must not duplicate the format rules (they live in prompt-contract.js)`);
    }
});

test('style files no longer duplicate the anchor-verbatim rule', () => {
    for (const f of STYLE_FILES) {
        const src = readFileSync(join(promptsDir, f), 'utf8');
        assert.ok(!src.includes('"anchor" MUST be the EXACT verbatim'),
            `${f} must not re-state the anchor rule`);
    }
});

test('style files no longer duplicate the nominative/bracket rules', () => {
    for (const f of STYLE_FILES) {
        const src = readFileSync(join(promptsDir, f), 'utf8');
        assert.ok(!src.includes('Do NOT put bracket notation in the "text" field'),
            `${f} must not re-state the bracket ban`);
        assert.ok(!src.includes('благовониями'),
            `${f} must not re-state the oblique-form example`);
    }
});

// ── 3. {{CONTRACT}} marker placement ──

test('every style file carries the {{CONTRACT}} marker', () => {
    for (const f of STYLE_FILES) {
        const src = readFileSync(join(promptsDir, f), 'utf8');
        assert.ok(src.includes('{{CONTRACT}}'),
            `${f} must carry the {{CONTRACT}} marker where the format section was`);
    }
});

test('language.md and hybrid.md are untouched (no marker needed)', () => {
    for (const f of ['language.md', 'hybrid.md']) {
        const p = join(promptsDir, f);
        assert.ok(existsSync(p), `${f} must still exist`);
        const src = readFileSync(p, 'utf8');
        // These keep their own format rules — they must NOT have the marker.
        assert.ok(!src.includes('{{CONTRACT}}'), `${f} must keep its own format rules`);
    }
});

// ── 4. Contract text equals what the old per-style sections contained ──
// Sanity: the marker replacement in loadPromptStyle is lossless — the contract
// string itself must not contain leftover {{...}} placeholders that would be
// emitted raw.

test('FOOTNOTE_CONTRACT has no unresolved {{placeholders}}', () => {
    assert.doesNotMatch(FOOTNOTE_CONTRACT, /\{\{[A-Z_]+\}\}/);
});
