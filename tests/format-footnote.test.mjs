import { test } from 'node:test';
import assert from 'node:assert/strict';

// Phase 1b test: sanitize (DOMPurify) + formatFootnoteText (mini-markdown).
//
// The DOMPurify CONTRACT (FORBID_TAGS forwarding, verdict pass-through,
// fail-closed escape) is pinned by the spy tests in the sanitize section
// below: they intercept the real backend call instead of re-implementing it.
// The formatFootnoteText pipeline tests, however, need a backend that
// actually strips dangerous tags — stub-runtime's identity DOMPurify would
// let <img>/<a>/<script> through and those assertions would wrongly fail.
// Real DOMPurify is unavailable under Node, so a mimic of its FORBID_TAGS
// behaviour is installed to serve as that backend.

import './helpers/stub-runtime.mjs';

// DOMPurify mimic (pipeline backend only, see above): strip FORBID_TAGS
// entirely and neuter on* attributes + the javascript: scheme.
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

import { formatFootnoteText, splitFootnoteHead } from '../src/footnote-format.js';
import { sanitize, escapeHtml } from '../src/core.js';
import { stripLeadingNumber } from '../src/parser.js';

// ── sanitize: DOMPurify contract (spy pattern) ──
// The tests intercept the single backend call core.sanitize makes — the
// assertions pin the contract AROUND DOMPurify, not any mimic's behaviour.

test('sanitize forwards FORBID_TAGS to DOMPurify once and passes its verdict through', () => {
    const calls = [];
    const orig = SillyTavern.libs.DOMPurify.sanitize;
    SillyTavern.libs.DOMPurify.sanitize = (html, opts) => {
        calls.push({ html, opts });
        return 'CLEAN';
    };
    try {
        assert.equal(sanitize('<img src=x>'), 'CLEAN');   // DOMPurify's verdict wins
        assert.equal(calls.length, 1, 'exactly one backend call');
        assert.equal(sanitize('<img src=x>'), 'CLEAN');
        assert.equal(calls.length, 1, 'LRU: the repeat is served from the cache, not DOMPurify');
        assert.deepEqual(
            calls[0].opts?.FORBID_TAGS,
            ['img', 'a', 'video', 'audio', 'source', 'iframe', 'object', 'embed'],
        );
    } finally {
        SillyTavern.libs.DOMPurify.sanitize = orig;
    }
});

test('sanitize fails closed: a throwing DOMPurify yields escapeHtml, never raw HTML', () => {
    const orig = SillyTavern.libs.DOMPurify.sanitize;
    SillyTavern.libs.DOMPurify.sanitize = () => { throw new Error('boom'); };
    try {
        const raw = '<img src=x onerror=1>';
        assert.equal(sanitize(raw), escapeHtml(raw));
    } finally {
        SillyTavern.libs.DOMPurify.sanitize = orig;
    }
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

// ── formatFootnoteText: [text](url) links ──

test('formatFootnoteText renders [text](url) as a safe anchor', () => {
    const out = formatFootnoteText('([docs.sillytavern.app](https://docs.sillytavern.app/?utm_source=openai))');
    assert.equal(
        out,
        '(<a href="https://docs.sillytavern.app/?utm_source=openai" target="_blank" rel="noopener noreferrer">docs.sillytavern.app</a>)',
    );
});

test('formatFootnoteText keeps balanced parens inside the URL', () => {
    const out = formatFootnoteText('[w](https://en.wikipedia.org/wiki/A_(b))');
    assert.equal(
        out,
        '<a href="https://en.wikipedia.org/wiki/A_(b)" target="_blank" rel="noopener noreferrer">w</a>',
    );
});

test('formatFootnoteText: prose parens around a link stay outside the href', () => {
    const out = formatFootnoteText('([w](https://en.wikipedia.org/wiki/A_(b)))');
    assert.ok(out.includes('href="https://en.wikipedia.org/wiki/A_(b)"'));
    // "("<a…>w</a>")" — the outer prose ")" must not be swallowed into the URL.
    assert.ok(out.startsWith('(<a '), 'leading prose paren stays outside the anchor');
    assert.ok(out.endsWith('</a>)'), 'trailing prose paren stays outside the anchor');
});

test('formatFootnoteText does not link javascript: / data: schemes', () => {
    // The URL group requires ^https?:// — anything else stays literal text.
    assert.equal(formatFootnoteText('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
    assert.equal(formatFootnoteText('[x](data:text/html,<b>)'), '[x](data:text/html,<b>)');
});

test('formatFootnoteText does not link URLs with a quote (href breakout)', () => {
    // A quote in the URL would let it escape the href="…" attribute — the
    // charset rejects it, so the whole markdown stays inert text.
    assert.equal(formatFootnoteText('[x](https://a");alert(1;//)'), '[x](https://a");alert(1;//)');
});

test('formatFootnoteText leaves bare URLs untouched', () => {
    // Only markdown links render as anchors; a bare URL keeps its literal form.
    assert.equal(formatFootnoteText('see https://example.com here'), 'see https://example.com here');
});

test('formatFootnoteText: markdown inside link text still formats', () => {
    const out = formatFootnoteText('[**Wiki** page](https://x.com/page)');
    assert.ok(out.includes('<a href="https://x.com/page"'));
    assert.ok(out.includes('<strong>Wiki</strong> page</a>'));
});

test('formatFootnoteText renders multiple links on one line', () => {
    const out = formatFootnoteText('[a](https://x.y) and [b](https://z.w)');
    assert.equal((out.match(/<a href=/g) || []).length, 2);
    assert.ok(out.includes('rel="noopener noreferrer">a</a> and'));
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
