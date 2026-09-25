// @ts-check
/**
 * Glosses — Icon set (Lucide/Feather-style inline SVG sprite).
 * Self-contained: no Font Awesome dependency for the UI panel + launcher.
 * The settings.html panel keeps FA (out of scope); this only covers the
 * floating panel header, launcher button, and empty-state.
 *
 * One <symbol>-sprite is mounted into <body> on first initIconSprite().
 * Icons are referenced via iconHtml(name) →
 *   '<svg class="gls-icon"><use href="#gls-i-name"/></svg>'.
 *
 * Ported from DS Comments/src/ui/icons.js (renamed prefix dsc→gls).
 */

// 24×24 viewBox, stroke currentColor, width 1.75, round caps/joins.
// (v3.2: the hand-drawn 'footnote' Tⁿ glyph was retired with the launcher's
// switch to Font Awesome fa-superscript — see src/ui/launcher.js.)
const ICONS = {
    // nav prev / chevron-left
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    // nav next / chevron-right
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    // collapse / minus
    minus: '<path d="M5 12h14"/>',
    // clear / trash
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    // close / x
    xmark: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    // copy
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    // check (copy-confirm feedback)
    check: '<path d="M20 6 9 17l-5-5"/>',
    // edit / pen
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    // regen / superscript (footnote badge)
    superscript: '<path d="m4 19 4-4 4 4"/><path d="M4 19v-7"/><path d="M12 19h8"/><path d="M16 19V8h-2"/><path d="M18 5.5h-4"/>',
    // spinner (for generation progress)
    spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    // message-square (empty state)
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    // sparkles (empty CTA)
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    // warn — triangle with exclamation (§6.4 unconfigured badge)
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    // ban / hide — circle with diagonal slash (exclude from pool)
    ban: '<circle cx="12" cy="12" r="9"/><path d="m4.93 4.93 14.14 14.14"/>',
    // rotate-ccw — undo restore (return anchor to the pool)
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    // crosshair — jump to the focused post in the chat (panel header)
    crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
};

let _spriteMounted = false;

/** Mount the SVG sprite (idempotent). Safe to call repeatedly. */
export function initIconSprite() {
    if (_spriteMounted || typeof document === 'undefined') return;
    if (document.getElementById('gls-icon-sprite')) { _spriteMounted = true; return; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'gls-icon-sprite';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    let inner = '';
    for (const [name, paths] of Object.entries(ICONS)) {
        inner += `<symbol id="gls-i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${paths}</symbol>`;
    }
    svg.innerHTML = inner;
    document.body.appendChild(svg);
    _spriteMounted = true;
}

/**
 * Return an inline SVG icon referencing the sprite.
 * @param {string} name  key into ICONS (book, chevron-left, …)
 * @param {{spin?: boolean, size?: number}} [opts]
 * @returns {string}
 */
export function iconHtml(name, opts = {}) {
    const cls = opts.spin ? 'gls-icon gls-icon-spin' : 'gls-icon';
    const size = opts.size || 18;
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><use href="#gls-i-${name}"/></svg>`;
}
