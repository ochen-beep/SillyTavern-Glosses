import test from 'node:test';
import assert from 'node:assert/strict';

// Context-ranked placement: the payload stores prefix/suffix selectors
// computed around the occurrence the footnote was generated for. When an
// anchor occurs several times in a message, restore-time injection must wrap
// the occurrence matching the stored context — not jump to the first match.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { installMiniDom, el, txt } from './helpers/mini-dom.mjs';

installMiniDom();

const { loadSettings } = await import('../src/core.js');
const { injectHighlights } = await import('../src/renderer.js');

loadSettings();
resetCtx();

const SENTENCE = 'Старый фонарь над входом мигал. Она подняла глаза и увидела тот же фонарь над мостом.';

function buildMessage() {
    const mesText = el('div', 'mes_text', el('p', '', txt(SENTENCE)));
    return { mesText, mesEl: el('div', 'mes', mesText) };
}

function nodeBefore(piece) {
    const s = piece.parentNode?.childNodes ?? [];
    const i = s.indexOf(piece);
    return i >= 1 ? s[i - 1] : null;
}

test('marker wraps the occurrence matching the stored context, not the first match', () => {
    const { mesText, mesEl } = buildMessage();
    const FN = {
        index: 1,
        anchor: 'фонарь',
        text: '¹ Парный к фонарю у капсулы: когда-то они стояли на одном мосту.',
        prefix: 'тот же',
        suffix: 'над мостом',
    };

    injectHighlights(mesEl, [FN]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 1, 'single anchor → single marker piece');
    assert.equal(pieces[0].textContent, 'фонарь¹');

    // The wrapped occurrence must be the SECOND one: the text immediately
    // before the marker ends with the stored prefix.
    const before = nodeBefore(pieces[0]);
    assert.ok(before, 'marker has a preceding text node');
    assert.ok(before.nodeValue.endsWith('тот же '), 'marker sits after "тот же " (second occurrence)');
});

test('without stored context the first occurrence keeps winning', () => {
    const { mesText, mesEl } = buildMessage();
    const FN = { index: 1, anchor: 'фонарь', text: '¹ Уличный газовый фонарь.' };

    injectHighlights(mesEl, [FN]);

    const pieces = mesText.querySelectorAll('.gls-marker');
    assert.equal(pieces.length, 1);
    const before = nodeBefore(pieces[0]);
    assert.ok(before.nodeValue.startsWith('Старый '), 'no context → document-order (first) occurrence');
});
