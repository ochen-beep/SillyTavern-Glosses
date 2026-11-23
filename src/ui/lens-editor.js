// @ts-check
/**
 * Glosses — Hybrid lens editing UI (native ST modal editor).
 *
 * ✎ on a lens row opens ONE shared native ST modal (callGenericPopup,
 * POPUP_TYPE.TEXT) with the effective template; edits autosave as the user
 * types (debounced override write — no Save/Cancel ceremony; «Готово»/Esc
 * just close). Reset rides a customButton (action, popup stays open) and is
 * offered for BUILT-IN lenses only. The macro hint accordion lives inside the
 * modal; clicking a macro chip copies it. Custom-lens modals get an «Insert
 * base template» button (skeleton for lenses built from scratch).
 *
 * Listeners ride the settings panel's AbortController via the injected on()
 * wrapper; cache invalidation is injected as well (deps.invalidateLanguageCache).
 */

import { S, saveSettings, t, notifyUser, getExtBase, getCtx, HYBRID_BUILTIN_LENSES } from '../core.js';
import { showConfirmModal } from '../core.js';

/** Macro hint rows for the modal accordion. First row is universal
 *  ({{OUTPUT_LANGUAGE}} works in every lens); the rest interpolate ONLY in
 *  the built-in Language lens — custom lenses keep them as literal text. */
export const LENS_MACRO_HINTS = [
    { token: '{{OUTPUT_LANGUAGE}}', desc: 'Footnote text language — «Russian» / «English»', lensOnly: false },
    { token: '{{TARGET_LANG_NAME}}', desc: 'study language, full name', lensOnly: true },
    { token: '{{TARGET_LANG_CODE}}', desc: 'study language code (en, ja, …)', lensOnly: true },
    { token: '{{TARGET_LANG_LABEL}}', desc: 'short footnote label — (англ.), (Fr.)', lensOnly: true },
    { token: '{{CEFR_LEVEL}}', desc: 'selected CEFR level', lensOnly: true },
    { token: '{{CEFR_LEVEL_DESC}}', desc: 'CEFR level wording for the prompt', lensOnly: true },
    { token: '{{CONLANG_NOTE}}', desc: 'constructed-language attestation note', lensOnly: true },
    { token: '{{DIRECTION_TASK}}', desc: 'translation direction task wording', lensOnly: true },
    { token: '{{DIRECTION_PRIORITIES}}', desc: 'per-direction "what to footnote" list', lensOnly: true },
    { token: '{{GRAMMAR_RULE}}', desc: 'grammar-notes toggle rule', lensOnly: true },
    { token: '{{USAGE_RULE}}', desc: 'usage-example toggle rule', lensOnly: true },
];

/** Skeleton inserted into EMPTY custom lenses (voice + when + label + format). */
export const BASE_LENS_TEMPLATE = `### Lens: <name>
**Voice:** …
**Footnote when:** …
**Do NOT footnote:** …
**Label:** (Code.)
**Format quirk:** …`;

const LENS_LABELS = {
    language: 'Language', pratchett: 'Pratchett', canon: 'Canon',
    academic: 'Academic', meta: 'Meta', expansion: 'Canon expansion',
};

/** Trim-aware override write: whitespace body means "back to the bundled
 *  template" (same delete path as the Reset button). Unknown keys rejected. */
export function applyLensOverride(key, text, { invalidate = () => {} } = {}) {
    if (!HYBRID_BUILTIN_LENSES.includes(key)) return false;
    const clean = String(text ?? '');
    if (!S().builtinLensOverrides || typeof S().builtinLensOverrides !== 'object') {
        S().builtinLensOverrides = {};
    }
    if (clean.trim()) S().builtinLensOverrides[key] = clean;
    else delete S().builtinLensOverrides[key];
    invalidate();
    saveSettings();
    return true;
}

async function fetchLensTemplate(lens) {
    const resp = await fetch(`${getExtBase()}/prompts/lenses/${lens}.md`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} (lenses/${lens}.md)`);
    return resp.text();
}

function _newLensId() {
    try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
    return 'cl' + Date.now().toString(36);
}

/** Wire the lens UI. Called from bindSettingsUI with the live AbortController
 *  wrapper and the hybrid-cache invalidation hook. */
export function setupLensEditor({ on, invalidateLanguageCache }) {
    const deps = { invalidateLanguageCache };

    // ── Built-in lens rows (✎ edit / ⧉ copy) → native ST modal ──
    async function openLensModal(lens) {
        const ctx = getCtx();
        if (!ctx?.callGenericPopup || !ctx?.POPUP_TYPE?.TEXT) {
            notifyUser('error', t('SillyTavern update required for the lens editor.'));
            return;
        }
        const { wrapper, ta, flashSaved } = buildLensModalBody(t(LENS_LABELS[lens] || lens));
        // Effective template: the override when present, otherwise the bundled
        // file. A failed fetch leaves the empty textarea (autosave then acts as
        // a no-op reset, never data loss).
        ta.value = String(S().builtinLensOverrides?.[lens] || '')
            || await fetchLensTemplate(lens).catch(() => '');

        const apply = (text) => applyLensOverride(lens, text, { invalidate: deps.invalidateLanguageCache });
        let pending = null;
        ta.addEventListener('input', () => {
            flashSaved();
            clearTimeout(pending);
            pending = setTimeout(() => {
                apply(ta.value);
                // An emptied body deleted the override — surface the bundled
                // template again so the modal never sits on a void.
                if (!ta.value.trim()) {
                    fetchLensTemplate(lens).then((tpl) => { ta.value = tpl; }).catch(() => {});
                }
            }, 400);
        });

        /** CustomButton action does NOT close the popup: confirm → wipe the
         *  override → reload the bundled template into the open textarea. */
        const resetButton = {
            text: t('Reset to template'),
            icon: 'fa-rotate-left',
            classes: ['gls-lens-reset'],
            action: async () => {
                if (!await showConfirmModal(t('Reset this lens to the bundled template?'))) return;
                await fetchLensTemplate(lens).then((tpl) => { ta.value = tpl; }).catch(() => {});
                applyLensOverride(lens, '', { invalidate: deps.invalidateLanguageCache });
            },
        };

        await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE.TEXT, '', {
            okButton: t('Done'),
            cancelButton: t('Close'),
            wider: true,
            customButtons: [resetButton],
        });
        clearTimeout(pending);
    }

    async function copyBuiltinLens(lens) {
        const raw = String(S().builtinLensOverrides?.[lens] || '')
            || await fetchLensTemplate(lens).catch(() => '');
        if (!raw.trim()) return;
        // Lazy import: generator.js is heavy and settings-sync must not pull
        // it at bind time (same pattern as the CTA handlers in window.js).
        const { bakeLensCopyText } = await import('../generator.js');
        const lenses = S().customLenses || (S().customLenses = []);
        const id = _newLensId();
        lenses.push({
            id,
            name: `${t(LENS_LABELS[lens] || lens)} (${t('copy')})`,
            prompt: bakeLensCopyText(lens, raw),
            active: false,
        });
        renderCustomLenses(document.getElementById('gls_custom_lenses_list'), { highlightId: id });
        deps.invalidateLanguageCache();
        saveSettings();
        try { notifyUser('success', t('Lens copied to Custom lenses.'), `gls-lens-copy-${lens}`); } catch { /* non-fatal */ }
    }

    document.querySelectorAll('[data-gls-lens-edit]').forEach(btn => {
        on(btn, 'click', () => { void openLensModal(btn.dataset.glsLensEdit); });
    });
    document.querySelectorAll('[data-gls-lens-copy]').forEach(btn => {
        on(btn, 'click', () => { void copyBuiltinLens(btn.dataset.glsLensCopy); });
    });

    // ── Custom hybrid lenses ────────────────────────────────────────────────────
    // Each row: [✓ active] [name input] [✎ modal editor] [delete ✕]. A custom
    // lens contributes "### Lens: <name>\n<prompt>" to the assembled hybrid
    // prompt. {{OUTPUT_LANGUAGE}} is the only token substituted inside the
    // prompt body — no {{TARGET_LANG_*}}/{{CEFR_*}}.
    const customListEl = document.getElementById('gls_custom_lenses_list');
    if (customListEl) {
        renderCustomLenses(customListEl);
        on(document.getElementById('gls_add_custom_lens'), 'click', () => {
            const lenses = S().customLenses || (S().customLenses = []);
            lenses.push({ id: _newLensId(), name: t('New lens'), prompt: '', active: true });
            renderCustomLenses(customListEl);
            // Open the fresh lens's modal right away: empty prompt + the base
            // template button is where a from-scratch lens actually starts.
            const idx = lenses.length - 1;
            void openCustomLensModal(idx, lenses[idx].name);
            deps.invalidateLanguageCache();
            saveSettings();
        });
    }

    function _mutateCustomLens(fn) {
        if (!Array.isArray(S().customLenses)) S().customLenses = [];
        fn(S().customLenses);
        deps.invalidateLanguageCache();
        saveSettings();
    }

    async function openCustomLensModal(index, name) {
        const ctx = getCtx();
        if (!ctx?.callGenericPopup || !ctx?.POPUP_TYPE?.TEXT) {
            notifyUser('error', t('SillyTavern update required for the lens editor.'));
            return;
        }
        const { wrapper, ta, flashSaved } = buildLensModalBody(name, { showInsert: true });
        ta.value = String(S().customLenses?.[index]?.prompt ?? '');

        let pending = null;
        ta.addEventListener('input', () => {
            flashSaved();
            clearTimeout(pending);
            pending = setTimeout(() => {
                _mutateCustomLens(arr => { if (arr[index]) arr[index].prompt = ta.value; });
            }, 400);
        });

        await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE.TEXT, '', {
            okButton: t('Done'),
            cancelButton: t('Close'),
            wider: true,
        });
        clearTimeout(pending);
    }

    function renderCustomLenses(listEl, { highlightId = null } = {}) {
        if (!listEl) return;
        listEl.innerHTML = '';
        const lenses = S().customLenses || [];
        if (!lenses.length) {
            const empty = document.createElement('div');
            empty.className = 'gls-s-custom-lenses-empty';
            empty.textContent = t('No custom lenses yet.');
            listEl.appendChild(empty);
            return;
        }

        lenses.forEach((c, i) => {
            const row = document.createElement('div');
            row.className = 'gls-s-custom-lens-row';
            if (highlightId && c.id === highlightId) {
                row.classList.add('gls-lens-copied');
                setTimeout(() => row.classList.remove('gls-lens-copied'), 2200);
            }

            // Active checkbox (toggle without save-others)
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'checkbox';
            cb.checked = !!c.active;
            cb.title = t('Enable');
            on(cb, 'change', () => _mutateCustomLens(arr => { arr[i].active = cb.checked; }));

            // Name input
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'text_pole gls-s-grow';
            nameInput.value = c.name || '';
            nameInput.placeholder = t('Lens name');
            on(nameInput, 'input', () => _mutateCustomLens(arr => { arr[i].name = nameInput.value; }));

            // Edit button → the shared native modal editor
            const editBtn = document.createElement('div');
            editBtn.className = 'menu_button menu_button_icon';
            editBtn.title = t('Edit prompt');
            editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
            on(editBtn, 'click', () => { void openCustomLensModal(i, c.name || t('New lens')); });

            // Delete button
            const delBtn = document.createElement('div');
            delBtn.className = 'menu_button menu_button_icon';
            delBtn.title = t('Delete');
            delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            on(delBtn, 'click', () => {
                _mutateCustomLens(arr => { arr.splice(i, 1); });
                renderCustomLenses(listEl);
            });

            const controls = document.createElement('div');
            controls.className = 'gls-s-custom-lens-row-controls';
            controls.appendChild(nameInput);
            controls.appendChild(editBtn);
            controls.appendChild(delBtn);

            row.appendChild(cb);
            row.appendChild(controls);
            if (highlightId && c.id === highlightId) {
                const caption = document.createElement('span');
                caption.className = 'gls-lens-copied-caption';
                caption.textContent = t('✓ copied');
                controls.appendChild(caption);
                setTimeout(() => caption.remove(), 2200);
            }
            listEl.appendChild(row);
        });
    }

    // ── modal body builder ──────────────────────────────────────────────────────
    function buildLensModalBody(title, { showInsert = false } = {}) {
        const wrapper = document.createElement('div');
        wrapper.className = 'gls-lens-modal';

        const head = document.createElement('div');
        head.className = 'gls-lens-modal-head';
        const titleEl = document.createElement('div');
        titleEl.className = 'gls-lens-modal-title';
        titleEl.textContent = title;
        const saved = document.createElement('span');
        saved.className = 'gls-lens-modal-saved';
        saved.textContent = t('Saved');
        head.append(titleEl, saved);

        const ta = document.createElement('textarea');
        ta.className = 'text_pole gls-lens-modal-ta';
        ta.rows = 14;
        ta.spellcheck = false;

        const flashSaved = () => {
            saved.classList.add('is-visible');
            clearTimeout(flashSaved._t);
            flashSaved._t = setTimeout(() => saved.classList.remove('is-visible'), 1400);
        };

        wrapper.append(head, ta);

        if (showInsert) {
            const insert = document.createElement('button');
            insert.type = 'button';
            insert.className = 'menu_button gls-lens-insert';
            insert.innerHTML = `<i class="fa-solid fa-clipboard"></i><span>${t('Insert base template')}</span>`;
            insert.addEventListener('click', async () => {
                if (ta.value.trim() && !await showConfirmModal(t('Replace the current prompt with the base template?'))) return;
                ta.value = BASE_LENS_TEMPLATE;
                flashSaved();
                ta.focus();
            });
            wrapper.appendChild(insert);
        }

        wrapper.appendChild(buildMacroAccordion());
        return { wrapper, ta, flashSaved };
    }

    function buildMacroAccordion() {
        const details = document.createElement('details');
        details.className = 'gls-lens-macro';
        const summary = document.createElement('summary');
        summary.textContent = t('Lens macros — hint (click a macro to copy it)');
        const body = document.createElement('div');
        body.className = 'gls-lens-macro-body';
        for (const m of LENS_MACRO_HINTS) {
            const row = document.createElement('div');
            row.className = 'gls-lens-macro-row';
            const code = document.createElement('code');
            code.textContent = m.token;
            code.title = m.lensOnly ? t('Only in the Language lens') : '';
            code.addEventListener('click', () => {
                navigator.clipboard?.writeText(m.token)
                    .then(() => notifyUser('success', t('Macro copied to clipboard'), 'gls-macro-copy'))
                    .catch(() => {});
            });
            const desc = document.createElement('span');
            desc.className = 'gls-lens-macro-desc';
            desc.textContent = t(m.desc);
            row.append(code, desc);
            body.appendChild(row);
        }
        const note = document.createElement('div');
        note.className = 'gls-lens-macro-note';
        note.textContent = t('Macros after the first one work only in the Language lens. In a custom lens they stay as literal text — to get baked values, copy the Language lens with ⧉.');
        body.appendChild(note);
        details.append(summary, body);
        return details;
    }
}
