// @ts-check
/**
 * Glosses — shared popup header builder
 *
 * The popup header (icon-only Copy/Edit/Delete group + close ✕) used to be
 * hand-written in THREE places — renderer.js (the real popup), the
 * custom-css.js preview twin, and the static settings.html snapshot — and the
 * copies drifted within a single redesign: settings lost its tooltips while
 * the previews kept FontAwesome glyphs after the real popup moved to the icon
 * sprite. This builder is the single source of structure, classes, icons and
 * labels.
 *
 * Preview mode ({@see buildPopupHeader}) emits decorative placeholders:
 * spans instead of buttons (the preview container stays aria-hidden +
 * pointer-events:none), no handlers — the visual contract only. The real
 * popup leaves the actions group EMPTY: its behavior-bearing buttons come
 * from buildFootnoteActions and are appended by the caller, so click
 * handling never passes through here.
 */

import { t } from '../core.js';
import { iconHtml } from './icons.js';

/**
 * Build the popup header.
 *
 * @param {{ preview?: boolean, onClose?: (() => void) | null }} [opts]
 *   preview - decorative placeholders (no handlers, spans, sprite glyphs).
 *   onClose - real-popup close handler; omit in preview mode.
 * @returns {{ header: HTMLDivElement, actions: HTMLDivElement,
 *             close: HTMLElement }}
 */
export function buildPopupHeader({ preview = false, onClose = null } = {}) {
    const header = document.createElement('div');
    header.className = 'gls-popup-header';

    const actions = document.createElement('div');
    actions.className = 'gls-popup-actions';
    if (preview) {
        // Icon-only placeholders, same shape as the real buttons (which
        // buildFootnoteActions creates with identical classes + size 16).
        for (const [icon, label] of [['copy', 'Copy'], ['pen', 'Edit'], ['trash', 'Delete']]) {
            const btn = document.createElement('span');
            btn.className = 'gls-popup-action-btn';
            btn.title = t(label);
            btn.innerHTML = iconHtml(icon, { size: 16 });
            actions.appendChild(btn);
        }
    }

    const closeLabel = t('Close');
    let close;
    if (preview) {
        close = document.createElement('span');
        close.className = 'gls-popup-close';
        close.innerHTML = iconHtml('xmark', { size: 14 });
    } else {
        close = document.createElement('button');
        close.className = 'gls-popup-close';
        close.setAttribute('aria-label', closeLabel);
        close.addEventListener('click', () => onClose?.());
        close.innerHTML = iconHtml('xmark', { size: 14 });
    }
    close.title = closeLabel;

    // appendChild (not the variadic append()): this module also runs inside
    // the unit tests' minimal fake DOM, which only stubs the classic API.
    header.appendChild(actions);
    header.appendChild(close);
    return { header, actions, close };
}
