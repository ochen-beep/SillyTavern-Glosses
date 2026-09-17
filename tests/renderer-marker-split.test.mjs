import test from 'node:test';
import assert from 'node:assert/strict';

// Multi-piece marker tests: ST's markdown wraps «…» / "…" quotes in <q>, so an
// anchor containing a quoted term crosses a text-node boundary mid-phrase and
// wraps as several .gls-marker pieces. These tests pin the superscript to the
// END of the whole anchor (last piece), and the unwrap/idempotency contract.
//
// Load order matters: stub-runtime first (SillyTavern mock, fetch, toastr),
// then the mini DOM (replaces the placeholder document — renderer.js and
// core.js evaluate against it), then renderer.js.
import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { installMiniDom, el, txt } from './helpers/mini-dom.mjs';

installMiniDom();

const { loadSettings, S } = await import('../src/core.js');
const { injectHighlights, removeHighlights } = await import('../src/renderer.js');

loadSettings();
resetCtx();

/**
 * Production shape: `…счет в отделении <q>«Куттс»</q> на Кинг-стрит…` —
 * the anchor `отделении «Куттс»` spans the <q> boundary.
 */
function buildQuotedMessage() {
    const mesText = el('div', 'mes_text',
        el('p', '',
            txt('— Откройте расчетный счет в отделении '),
            el('q', '', txt('«Куттс»')),
            txt(' на Кинг-стрит, — распорядился Дамиен.'),
        ),
    );
    const mesEl = el('div', 'mes', mesText);
    return { mesEl, mesText };
}

const FN = {
    index: 10,
    anchor: 'отделении «Куттс»',
    text: '¹⁰ Банк «Куттс» (Pratchett) — Частный банк Coutts & Co.',
};

test('superscript rides the LAST piece of a quote-split anchor, not the first', () => {
    const { mesEl, mesText } = buildQuotedMessage();
    injectHighlights(mesEl, [FN]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 2, 'anchor crossing <q> wraps as two pieces');
    assert.equal(pieces[0].textContent, 'отделении ');
    assert.equal(pieces[1].textContent, '«Куттс»¹⁰');

    const sups = pieces.map(p => p.querySelector('.gls-sup'));
    assert.equal(sups[0], null, 'first piece must NOT carry the superscript');
    assert.notEqual(sups[1], null, 'last piece carries the superscript');
    assert.equal(sups[1].textContent, '¹⁰');
});

test('single-node anchor keeps one piece with a trailing superscript', () => {
    const mesText = el('div', 'mes_text',
        el('p', '', txt('Кожаная папка с тиснением бювара лежала на столе.')),
    );
    const mesEl = el('div', 'mes', mesText);
    injectHighlights(mesEl, [{ index: 1, anchor: 'бювара', text: '¹ Бювар (ит.) — настольная подкладка.' }]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 1);
    assert.equal(pieces[0].textContent, 'бювара¹');
    assert.notEqual(pieces[0].querySelector('.gls-sup'), null);
});

test('removeHighlights unwraps quote-split markers back to the original text', () => {
    const { mesEl, mesText } = buildQuotedMessage();
    const original = mesText.textContent;
    injectHighlights(mesEl, [FN]);
    removeHighlights(mesEl);
    assert.equal(mesText.textContent, original);
    assert.equal(mesText.querySelectorAll('.gls-marker').length, 0);
});
