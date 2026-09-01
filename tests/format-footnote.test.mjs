import { test } from 'node:test';
import assert from 'node:assert/strict';

// Phase 1b test: sanitize (DOMPurify) + formatFootnoteText (mini-markdown).
//
// stub-runtime.mjs installs DOMPurify.sanitize as identity by default — that
// would let <img>/<a>/<script> through and the XSS assertions below would
// wrongly fail. To test the real contract, we install a DOMPurify mock that
// mimics the FORBID_TAGS behaviour (strips media/link/script/embed tags +
// event-handler attributes) closely enough to verify formatFootnoteText's
// defence-in-depth. The production path uses ST's real DOMPurify.

import './helpers/stub-runtime.mjs';

// DOMPurify mock: strip FORBID_TAGS entirely and neuter on* attributes + the
// javascript: scheme. Mirrors what real DOMPurify does for our FORBID_TAGS set,
// plus script/style removal which DOMPurify does by default.
SillyTavern.libs.DOMPurify.sanitize = (html, opts = {}) => {
    const forbid = new Set(opts?.FORBID_TAGS || []);
    forbid.add('script'); forbid.add('style'); // DOMPurify default-denies these
    let s = String(html ?? '');
    // Remove forbidden tags (open/close/self-closing) entirely.
    const tagAlt = [...forbid].join('|');
    s = s.replace(new RegExp(`</?(?:${tagAlt})\\b[^>]*>`, 'gi'), '');
    // Strip on*= event handlers and javascript: URLs (real DOMPurify does both).
    s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/(href|src)\s*=\s*("|')javascript:[^"']*\2/gi, '$1="#"');
    return s;
};

import { formatFootnoteText, splitFootnoteHead } from '../src/renderer.js';
import { sanitize, escapeHtml } from '../src/core.js';
import { stripLeadingNumber } from '../src/parser.js';

// ── sanitize: XSS defence-in-depth ──

test('sanitize strips <img> tracking pixels', () => {
    const out = sanitize('<img src="http://evil/x.png">');
    assert.equal(out, '');
});

test('sanitize strips <a> phishing links', () => {
    const out = sanitize('<a href="http://evil.com">click</a>');
    assert.equal(out, 'click');
});

test('sanitize strips <script> blocks', () => {
    const out = sanitize('<script>alert(1)</script>');
    // Real DOMPurify strips the whole script element including content; our
    // mock only strips tags, leaving content. Verify the tag is gone (content
    // survival is acceptable since formatFootnoteText escapes via DOMPurify,
    // and <script> content without its tag can't execute).
    assert.ok(!out.includes('<script'), 'script tag must be removed');
});

test('sanitize strips onerror event handler from surviving tags', () => {
    // A <p onerror=...> survives the FORBID_TAGS list but loses its handler.
    const out = sanitize('<p onerror="alert(1)">text</p>');
    assert.ok(!out.includes('onerror'));
    assert.ok(out.includes('text'));
});

test('sanitize keeps safe inline tags (strong/em/code)', () => {
    const out = sanitize('<strong>b</strong> <em>i</em> <code>c</code>');
    assert.equal(out, '<strong>b</strong> <em>i</em> <code>c</code>');
});

test('sanitize LRU cache returns identical result for repeated input', () => {
    const a = sanitize('hello **world**');
    const b = sanitize('hello **world**');
    assert.equal(a, b);
});

// ── formatFootnoteText: mini-markdown ──

test('formatFootnoteText renders **bold**', () => {
    assert.equal(formatFootnoteText('a **b** c'), 'a <strong>b</strong> c');
});

test('formatFootnoteText renders *italic*', () => {
    assert.equal(formatFootnoteText('a *b* c'), 'a <em>b</em> c');
});

test('formatFootnoteText renders `code`', () => {
    assert.equal(formatFootnoteText('use `foo` here'), 'use <code>foo</code> here');
});

test('formatFootnoteText renders ~~strikethrough~~', () => {
    assert.equal(formatFootnoteText('~~old~~'), '<del>old</del>');
});

test('formatFootnoteText converts \\n to <br>', () => {
    assert.equal(formatFootnoteText('line1\nline2'), 'line1<br>line2');
});

test('formatFootnoteText strips fenced ``` code blocks to plain text', () => {
    const out = formatFootnoteText('```js\nconsole.log(1)\n```');
    assert.ok(!out.includes('```'));
    assert.ok(!out.includes('<code>console.log'));
});

test('formatFootnoteText: **bold** does not swallow *italic* on same line', () => {
    const out = formatFootnoteText('**bold** and *italic*');
    assert.ok(out.includes('<strong>bold</strong>'));
    assert.ok(out.includes('<em>italic</em>'));
});

// ── Defence-in-depth: model-injected HTML is neutralised ──

test('formatFootnoteText kills an injected <img onerror>', () => {
    const out = formatFootnoteText('<img src=x onerror=alert(1)>real text');
    assert.ok(!out.includes('<img'));
    assert.ok(!out.includes('onerror'));
    assert.ok(out.includes('real text'));
});

test('formatFootnoteText kills an injected <a href=javascript:>', () => {
    const out = formatFootnoteText('<a href="javascript:alert(1)">click</a>');
    assert.ok(!out.toLowerCase().includes('javascript:'));
    assert.ok(out.includes('click'));
});

test('formatFootnoteText preserves markdown across sanitization', () => {
    // The model emits real asterisks for emphasis; sanitize (identity-ish for
    // text) must not eat them, and markdown pass then converts them.
    const out = formatFootnoteText('See **term** (cat.) — meaning');
    assert.ok(out.includes('<strong>term</strong>'));
});

// ── escapeHtml (fail-closed path) ──

test('escapeHtml escapes &, <, >, ", \'', () => {
    assert.equal(
        escapeHtml('<img src=x onerror="alert(1)">&"\''),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&quot;&#39;',
    );
});

test('escapeHtml null/undefined → empty string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

// ── splitFootnoteHead (dictionary headword split for the popup title) ──

test('splitFootnoteHead splits at the first spaced em-dash', () => {
    const r = splitFootnoteHead('Нотный стан (англ.) — musical staff / stave · /ˈmjuː.zɪ.kəl stɑːf/ · «мью́зи-кэл стаф» · нотоносец из пяти линий.');
    assert.equal(r.head, 'Нотный стан (англ.)');
    assert.equal(r.body, 'musical staff / stave · /ˈmjuː.zɪ.kəl stɑːf/ · «мью́зи-кэл стаф» · нотоносец из пяти линий.');
});

test('splitFootnoteHead strips the model index before building the popup title', () => {
    // showPopup uses fn.index as the one canonical title index; the model also
    // embeds ⁷ in text by contract, so it must be removed before the split.
    const r = splitFootnoteHead(stripLeadingNumber('⁷ Крестовский остров (Canon) — Престижный остров в дельте Невы.'));
    assert.equal(r.head, 'Крестовский остров (Canon)');
    assert.equal(r.body, 'Престижный остров в дельте Невы.');
});

test('splitFootnoteHead accepts a spaced en-dash and picks the earliest separator', () => {
    assert.equal(splitFootnoteHead('Term – first – second').head, 'Term');
    assert.equal(splitFootnoteHead('Term – first — second').head, 'Term');
    assert.equal(splitFootnoteHead('Term — first – second').head, 'Term');
});

test('splitFootnoteHead splits at the FIRST dash only (body may contain more)', () => {
    const r = splitFootnoteHead('Kraken (норв.) — гигантский спрут · см. также — «leviathan»');
    assert.equal(r.head, 'Kraken (норв.)');
    assert.equal(r.body, 'гигантский спрут · см. также — «leviathan»');
});

test('splitFootnoteHead returns null when there is no spaced dash', () => {
    assert.equal(splitFootnoteHead('Просто текст без разделителя.'), null);
    // Unspaced dashes never split (red—hot compounds stay whole).
    assert.equal(splitFootnoteHead('red—hot iron'), null);
    assert.equal(splitFootnoteHead('термин—определение'), null);
});

test('splitFootnoteHead rejects multi-line and degenerate input', () => {
    assert.equal(splitFootnoteHead('Term —\ndefinition'), null);
    assert.equal(splitFootnoteHead(''), null);
    assert.equal(splitFootnoteHead(null), null);
    assert.equal(splitFootnoteHead(undefined), null);
    // Head starting the text (dash at 0) is not a headword.
    assert.equal(splitFootnoteHead('— определение'), null);
});

test('splitFootnoteHead rejects heads over 80 chars (a sentence, not a headword)', () => {
    const longHead = 'а'.repeat(81);
    assert.equal(splitFootnoteHead(`${longHead} — тело`), null);
    // Exactly 80 still splits.
    const maxHead = 'а'.repeat(80);
    const r = splitFootnoteHead(`${maxHead} — тело`);
    assert.equal(r.head, maxHead);
    assert.equal(r.body, 'тело');
});

test('splitFootnoteHead yields non-empty trimmed halves', () => {
    assert.equal(splitFootnoteHead('Term —    '), null); // whitespace-only body → null
    assert.equal(splitFootnoteHead('   Term   —   body text   ').body, 'body text');
});
