// @ts-check
/**
 * Glosses — skin gallery (Display section)
 *
 * A strip of chips, one per popup skin, each painted with THAT skin's real
 * computed palette. True isolated thumbnails are impossible with the skin
 * architecture: skin rules are descendant selectors from :root
 * (`.gls-popup-skin-x .gls-popup`), so two skins can never style two elements
 * independently in one document — a card carrying its own skin class would
 * still also match the :root-level skin, and stylesheet order would decide
 * the winner.
 *
 * So each chip extracts the skin's palette by momentarily mounting the skin
 * class on :root and reading computed styles off a hidden probe — all in one
 * synchronous loop, so the browser never paints an intermediate state (no
 * flicker) and the user's current skin is restored before control returns.
 * Clicking a chip routes through the existing #gls_popup_theme select's
 * change event — one code path applies and persists the choice.
 *
 * DOM API note: this module also runs inside the unit tests' minimal fake
 * DOM, so it sticks to the classic surface (appendChild, getAttribute,
 * classList.add/remove/toggle/contains) — no variadic append(), no spread
 * over classList, no dataset, no querySelectorAll on the strip.
 */

import { S } from '../core.js';

const SKIN_CLASS_PREFIX = 'gls-popup-skin-';
// Single source of the skin id vocabulary — applyHighlightStyles (renderer.js)
// imports this same list for its :root class reset; settings.html's
// #gls_popup_theme options must stay in sync with it.
export const SKINS = [
    'adaptive', 'paper', 'terminal', 'telegram', 'bubble', 'glass', 'codex',
    'neon', 'vellum', 'inkwell', 'washi', 'tideglass', 'herbarium', 'marquee',
    'rime', 'adobe', 'velvet', 'phosphor', 'rosewindow', 'mahou', 'moonjar',
    'cinnabar', 'koyo', 'gloam', 'afterglow', 'starseed',
];

/** English names mirroring the settings.html option texts (fake-DOM fallback
 *  when the select's options collection is not readable). */
const FALLBACK_LABELS = {
    adaptive: 'Adaptive (match theme)', paper: 'Paper note', terminal: 'Terminal',
    telegram: 'Telegram blank', bubble: 'Messenger bubble', glass: 'Frosted glass',
    codex: 'Ancient codex', neon: 'Neon', vellum: 'Vellum', inkwell: 'Inkwell',
    washi: 'Washi', tideglass: 'Tideglass', herbarium: 'Herbarium',
    marquee: 'Marquee', rime: 'Rime', adobe: 'Adobe', velvet: 'Velvet',
    phosphor: 'Phosphor', rosewindow: 'Rosewindow', mahou: 'Mahou',
    moonjar: 'Moonjar', cinnabar: 'Cinnabar', koyo: 'Koyo', gloam: 'Gloam',
    afterglow: 'Afterglow', starseed: 'Starseed',
};

const currentSkin = () => {
    const v = S().popupTheme;
    return SKINS.includes(v) ? v : 'adaptive';
};

/**
 * Chip entries: skin ids from the fixed vocabulary, labels from the select's
 * option texts when they are readable (they carry ST's translated text) and
 * the English fallbacks otherwise.
 */
const readEntries = (select) => SKINS.map((value) => {
    let label = FALLBACK_LABELS[value] ?? value;
    try {
        const options = select?.options;
        if (options) {
            for (let i = 0; i < options.length; i++) {
                if (options[i]?.value === value) { label = options[i].text || label; break; }
            }
        }
    } catch { /* fake DOM / exotic select — fallback label stands */ }
    return { value, label };
});

/**
 * Build the gallery strip for the given theme <select>.
 * @param {HTMLSelectElement} select - the #gls_popup_theme control whose
 *   options enumerate the skins (value → skin id) and whose change handler
 *   applies the choice.
 * @param {{ on?: ((el: Element, ev: string, fn: () => void) => void) | null }} [hooks]
 *   on - the host module's signal-scoped addEventListener wrapper. The
 *   gallery's own sync listener MUST ride the same abort signal as the rest
 *   of the settings bindings (unbind must detach it), so settings-sync
 *   passes its `on()` here. Falls back to raw addEventListener for tests.
 * @returns {HTMLDivElement} the gallery strip, ready to insert after the
 *   select's field group.
 */
export function buildSkinGallery(select, { on: onListen = null } = {}) {
    const listen = (el, ev, fn) => {
        if (typeof onListen === 'function') onListen(el, ev, fn);
        else el.addEventListener(ev, fn);
    };
    const strip = document.createElement('div');
    strip.className = 'gls-skin-gallery';
    strip.id = 'gls_skin_gallery';

    // Hidden probe carrying BOTH classes the skin rules key on. Computed
    // styles only resolve for in-document elements, and the caller inserts
    // the strip AFTER this builder returns — so measurement temporarily
    // attaches the strip to document.body and detaches it when done, all
    // within one synchronous pass (never painted, no flicker). Without a
    // measurable environment (unit-test fake DOM) measurement is skipped
    // and chips render with default styling — layout still holds.
    const canMeasure = typeof getComputedStyle === 'function' && !!document.body;
    const probe = document.createElement('div');
    probe.className = 'gls-popup gls-popup-preview';
    probe.style.cssText = 'position:absolute;width:10px;height:10px;visibility:hidden;pointer-events:none;';
    if (canMeasure) document.body.appendChild(strip);
    strip.appendChild(probe);

    const root = document.documentElement;
    /** Mount exactly one skin on :root (removing every known skin class). */
    const setRootSkin = (value) => {
        for (const s of SKINS) root.classList.remove(SKIN_CLASS_PREFIX + s);
        if (value !== 'adaptive') root.classList.add(SKIN_CLASS_PREFIX + value);
    };

    const entries = readEntries(select);
    const palettes = new Map();
    if (canMeasure) {
        for (const { value } of entries) {
            setRootSkin(value);
            const cs = getComputedStyle(probe);
            palettes.set(value, {
                bg: cs.backgroundColor,
                // Skins like codex/vellum paint texture gradients via
                // background-image; a flat backgroundColor alone reads much
                // darker than the skin looks in practice.
                image: cs.backgroundImage !== 'none' ? cs.backgroundImage : '',
                color: cs.color,
                border: cs.borderColor,
            });
        }
        // Restore the user's skin before anything can paint.
        setRootSkin(currentSkin());
        probe.remove();
        strip.remove();
    }

    const chips = [];
    for (const { value, label } of entries) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'gls-skin-chip';
        chip.setAttribute('data-value', value);
        chip.title = label;
        chip.setAttribute('aria-label', label);

        const swatch = document.createElement('span');
        swatch.className = 'gls-skin-chip-swatch';
        const palette = palettes.get(value);
        if (palette) {
            swatch.style.background = palette.bg;
            if (palette.image) swatch.style.backgroundImage = palette.image;
            swatch.style.color = palette.color;
            swatch.style.borderColor = palette.border;
        }
        swatch.textContent = 'A¹';
        swatch.setAttribute('aria-hidden', 'true');

        const name = document.createElement('span');
        name.className = 'gls-skin-chip-name';
        name.textContent = label;

        chip.appendChild(swatch);
        chip.appendChild(name);
        chip.addEventListener('click', () => {
            if (select.value === value) return;
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        strip.appendChild(chip);
        chips.push({ value, chip });
    }

    const sync = () => {
        const current = currentSkin();
        for (const { value, chip } of chips) {
            const active = value === current;
            chip.classList.toggle('gls-skin-chip--active', active);
            chip.setAttribute('aria-pressed', String(active));
        }
    };
    // Registered through the hook so the sync listener unbinds with the
    // settings signal, exactly like every other settings binding.
    listen(select, 'change', sync);
    sync();

    return strip;
}
