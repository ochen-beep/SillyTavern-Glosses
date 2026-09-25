import test from 'node:test';
import assert from 'node:assert/strict';

// Seam classes for multi-piece markers. An anchor crossing ST's <q> quote wrap
// renders as several .gls-marker pieces; each piece is its own inline box with
// padding: 0 1px and border-radius: 2px, so the joint reads as TWO highlight
// chips instead of one band. The renderer must tag the pieces with
// gls-marker-seam-r / gls-marker-seam-l (CSS then zeroes the inner-side
// padding and radii) while a single-piece marker keeps its full pill look.
//
// Load order matters: stub-runtime first (SillyTavern mock, fetch, toastr),
// then the mini DOM, then renderer.js.
import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { installMiniDom, el, txt } from './helpers/mini-dom.mjs';

installMiniDom();

const { loadSettings, S } = await import('../src/core.js');
const { injectHighlights, removeHighlights, markerSeamClasses } = await import('../src/renderer.js');

loadSettings();
resetCtx();

/** Production shape: `…отделении <q>«Куттс»</q> на Кинг-стрит…` — the anchor
 *  `отделении «Куттс»` spans the <q> boundary and wraps as two pieces. */
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

test('markerSeamClasses maps piece position to seam sides', () => {
    assert.deepEqual(markerSeamClasses(0, 1), [], 'single piece: full pill, no seam');
    assert.deepEqual(markerSeamClasses(0, 2), ['gls-marker-seam-r'], 'first of two: flat right edge');
    assert.deepEqual(markerSeamClasses(1, 2), ['gls-marker-seam-l'], 'last of two: flat left edge');
    assert.deepEqual(markerSeamClasses(0, 4), ['gls-marker-seam-r']);
    assert.deepEqual(markerSeamClasses(1, 4), ['gls-marker-seam-r', 'gls-marker-seam-l'], 'middle pieces: both edges flat');
    assert.deepEqual(markerSeamClasses(3, 4), ['gls-marker-seam-l']);
});

test('quote-split pieces carry seam classes; edges match their side of the joint', () => {
    const { mesEl, mesText } = buildQuotedMessage();
    injectHighlights(mesEl, [FN]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 2);
    assert.equal(pieces[0].textContent, 'отделении ');
    assert.ok(pieces[0].classList.contains('gls-marker-seam-r'), 'first piece flattens its right edge');
    assert.ok(!pieces[0].classList.contains('gls-marker-seam-l'), 'first piece keeps its rounded left edge');
    assert.equal(pieces[1].textContent, '«Куттс»¹⁰');
    assert.ok(pieces[1].classList.contains('gls-marker-seam-l'), 'last piece flattens its left edge');
    assert.ok(!pieces[1].classList.contains('gls-marker-seam-r'), 'last piece keeps its rounded right edge');
});

test('single-node anchor gets no seam classes', () => {
    const mesText = el('div', 'mes_text',
        el('p', '', txt('Кожаная папка с тиснением бювара лежала на столе.')),
    );
    const mesEl = el('div', 'mes', mesText);
    injectHighlights(mesEl, [{ index: 1, anchor: 'бювара', text: '¹ Бювар (ит.) — настольная подкладка.' }]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 1);
    assert.ok(!pieces[0].classList.contains('gls-marker-seam-r'));
    assert.ok(!pieces[0].classList.contains('gls-marker-seam-l'));
});

test('a 3+ piece anchor flattens both edges of the middle pieces', () => {
    const mesText = el('div', 'mes_text',
        el('p', '',
            txt('Он сказал '),
            el('q', '', txt('«слово»')),
            txt(' и '),
            el('em', '', txt('ушёл')),
            txt(' сразу.'),
        ),
    );
    const mesEl = el('div', 'mes', mesText);
    injectHighlights(mesEl, [{ index: 2, anchor: 'сказал «слово» и ушёл', text: '² Тест.' }]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 4, 'anchor crosses two element boundaries → four pieces');
    const sides = pieces.map(p => [
        p.classList.contains('gls-marker-seam-r') ? 'r' : '',
        p.classList.contains('gls-marker-seam-l') ? 'l' : '',
    ].join(''));
    assert.deepEqual(sides, ['r', 'rl', 'rl', 'l']);
});

test('seam classes do not break unwrap/idempotency', () => {
    const { mesEl, mesText } = buildQuotedMessage();
    const original = mesText.textContent;
    injectHighlights(mesEl, [FN]);
    removeHighlights(mesEl);
    assert.equal(mesText.textContent, original);
    injectHighlights(mesEl, [FN]);
    assert.equal(mesText.querySelectorAll('.gls-marker').length, 2, 're-inject after unwrap stays 2 pieces');
    removeHighlights(mesEl);
    assert.equal(mesText.textContent, original);
});
