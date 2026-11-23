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
//   1. No style file still duplicates the contract rules (no "### Format
//      requirements") — the rules live in prompt-contract.js only.
//   2. Every style file carries no {{CONTRACT}} marker (vibe-only surfaces).
//   3. The contract text itself has no unresolved {{placeholders}}.

import './helpers/stub-runtime.mjs';
import { FOOTNOTE_CONTRACT } from '../src/prompt-contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, '..', 'prompts');

// Live style surfaces: the lens templates + the hybrid envelope. The classic
// per-style files are retired (their presets are covered by the lenses), so
// the duplication guard now watches the files that actually ship.
const STYLE_FILES = [
    'hybrid.md',
    'lenses/language.md',
    'lenses/pratchett.md',
    'lenses/canon.md',
    'lenses/academic.md',
    'lenses/meta.md',
    'lenses/expansion.md',
];

// ── 1. No duplication left in the style files ──

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

test('style files no longer duplicate the translation boundary', () => {
    for (const f of STYLE_FILES) {
        const src = readFileSync(join(promptsDir, f), 'utf8');
        assert.ok(!src.includes('### Translation boundary'),
            `${f} must not re-state the translation boundary (it lives in the contract)`);
    }
});

test('hybrid.md carries the lens envelope only (no format/translation rules)', () => {
    const src = readFileSync(join(promptsDir, 'hybrid.md'), 'utf8');
    assert.ok(!src.includes('### Common format'),
        'hybrid.md must not re-state the common format rules (they live in the contracts)');
    assert.ok(!src.includes('Translation boundary'),
        'hybrid.md must not re-state the translation boundary (it lives in the contracts)');
});

// ── 2. {{CONTRACT}} marker placement ──

test('live style surfaces carry no contract marker', () => {
    for (const f of STYLE_FILES) {
        const p = join(promptsDir, f);
        assert.ok(existsSync(p), `${f} must still exist`);
        const src = readFileSync(p, 'utf8');
        // Style files are vibe-only: the format rules ride the user-message
        // contract (generator.js _CONTRACT_TAIL), never a {{CONTRACT}} marker.
        assert.ok(!src.includes('{{CONTRACT}}'), `${f} must not carry the contract marker`);
    }
});

// ── 3. Contract text sanity ──
// The contract string itself must not contain leftover {{...}} placeholders that would be
// emitted raw.

test('FOOTNOTE_CONTRACT has no unresolved {{placeholders}}', () => {
    assert.doesNotMatch(FOOTNOTE_CONTRACT, /\{\{[A-Z_]+\}\}/);
});
