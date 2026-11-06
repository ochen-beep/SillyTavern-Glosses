// @ts-check
/**
 * Glosses — Hybrid lens editing UI.
 *
 * Extracted verbatim from settings-sync.js (R-7.5 module split): the
 * built-in-lens override editor (✎ edit / ⧉ copy per lens row, one shared
 * editor dialog) and the custom-lens rows. Listeners ride the settings
 * panel's AbortController via the injected on() wrapper; cache invalidation
 * is injected as well (deps.invalidateLanguageCache).
 */

import { S, saveSettings, t, notifyUser, getExtBase, HYBRID_BUILTIN_LENSES } from '../core.js';

/**
 * Wire the lens UI. Called from bindSettingsUI with the live AbortController
 * wrapper and the hybrid-cache invalidation hook.
 */
export function setupLensEditor({ on, invalidateLanguageCache }) {
    const deps = { invalidateLanguageCache };

    
        // ── Built-in lens overrides (✎ edit / ⧉ copy per lens row) ──
        const LENS_LABELS = {
            language: 'Language', pratchett: 'Pratchett', canon: 'Canon',
            academic: 'Academic', meta: 'Meta', expansion: 'Canon expansion',
        };
        let _editingLens = null;
    
        async function fetchLensTemplate(lens) {
            const resp = await fetch(`${getExtBase()}/prompts/lenses/${lens}.md`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} (lenses/${lens}.md)`);
            return resp.text();
        }
    
        function refreshLensDots() {
            const overrides = S().builtinLensOverrides || {};
            document.querySelectorAll('[data-gls-lens-dot]').forEach(dot => {
                const lens = dot.dataset.glsLensDot;
                if (HYBRID_BUILTIN_LENSES.includes(lens)) dot.hidden = !String(overrides[lens] || '').trim();
            });
        }
    
        async function openLensEditor(lens) {
            _editingLens = lens;
            const title = document.getElementById('gls_builtin_lens_editor_title');
            const input = document.getElementById('gls_builtin_lens_input');
            const editor = document.getElementById('gls_builtin_lens_editor');
            if (!title || !input || !editor) return;
            title.textContent = t(LENS_LABELS[lens] || lens);
            // The editor shows the EFFECTIVE template: the override when present,
            // otherwise the bundled file. A failed fetch leaves the empty textarea
            // (saving it would be a no-op reset, never data loss).
            input.value = String(S().builtinLensOverrides?.[lens] || '')
                || await fetchLensTemplate(lens).catch(() => '');
            editor.hidden = false;
            input.focus();
        }
    
        function closeLensEditor() {
            _editingLens = null;
            const editor = document.getElementById('gls_builtin_lens_editor');
            if (editor) editor.hidden = true;
        }
    
        function saveLensOverride() {
            if (!_editingLens) return;
            const input = document.getElementById('gls_builtin_lens_input');
            if (!input) return;
            const text = String(input.value ?? '');
            if (!S().builtinLensOverrides || typeof S().builtinLensOverrides !== 'object') {
                S().builtinLensOverrides = {};
            }
            // A whitespace-only body means "back to the bundled template" — the
            // same delete path as the explicit Reset button (documented in the hint).
            if (text.trim()) S().builtinLensOverrides[_editingLens] = text;
            else delete S().builtinLensOverrides[_editingLens];
            deps.invalidateLanguageCache();
            saveSettings();
            refreshLensDots();
            closeLensEditor();
        }
    
        function resetLensOverride() {
            if (!_editingLens) return;
            delete S().builtinLensOverrides[_editingLens];
            deps.invalidateLanguageCache();
            saveSettings();
            refreshLensDots();
            closeLensEditor();
        }
    
        async function copyBuiltinLens(lens) {
            const raw = String(S().builtinLensOverrides?.[lens] || '')
                || await fetchLensTemplate(lens).catch(() => '');
            if (!raw.trim()) return;
            // Lazy import: generator.js is heavy and settings-sync must not pull
            // it at bind time (same pattern as the CTA handlers in window.js).
            const { bakeLensCopyText } = await import('../generator.js');
            const lenses = S().customLenses || (S().customLenses = []);
            lenses.push({
                id: _newLensId(),
                name: `${t(LENS_LABELS[lens] || lens)} (${t('copy')})`,
                prompt: bakeLensCopyText(lens, raw),
                active: false,
            });
            renderCustomLenses(document.getElementById('gls_custom_lenses_list'));
            deps.invalidateLanguageCache();
            saveSettings();
            try { notifyUser('success', t('Lens copied to Custom lenses.'), `gls-lens-copy-${lens}`); } catch { /* non-fatal */ }
        }
    
        document.querySelectorAll('[data-gls-lens-edit]').forEach(btn => {
            on(btn, 'click', () => { void openLensEditor(btn.dataset.glsLensEdit); });
        });
        document.querySelectorAll('[data-gls-lens-copy]').forEach(btn => {
            on(btn, 'click', () => { void copyBuiltinLens(btn.dataset.glsLensCopy); });
        });
        on(document.getElementById('gls_builtin_lens_save'), 'click', saveLensOverride);
        on(document.getElementById('gls_builtin_lens_reset'), 'click', resetLensOverride);
        on(document.getElementById('gls_builtin_lens_cancel'), 'click', closeLensEditor);
        // JS-set hint: ST's data-i18n observer does not reliably translate this
        // node (same workaround as the target-language optgroup labels above).
        const lensHintEl = document.getElementById('gls_builtin_lens_hint');
        if (lensHintEl) {
            lensHintEl.textContent = t('Same tokens as the bundled template: {{OUTPUT_LANGUAGE}} everywhere; the Language lens also accepts {{TARGET_LANG_*}}, {{CEFR_*}} and {{CONLANG_NOTE}}. Saving an empty body resets to the bundled template.');
        }
        refreshLensDots();
    
        // Custom hybrid lenses (user-authored roles). Wired together so any
        // mutation flips the hybrid cache + persists — lets the user build a
        // universal prompt from built-in + their own lenses. See
        // _buildHybridPrompt in generator.js.
        const customListEl = document.getElementById('gls_custom_lenses_list');
        if (customListEl) {
            renderCustomLenses(customListEl);
            on(document.getElementById('gls_add_custom_lens'), 'click', () => {
                const lenses = S().customLenses || (S().customLenses = []);
                lenses.push({ id: _newLensId(), name: t('New lens'), prompt: '', active: true });
                renderCustomLenses(customListEl);
                deps.invalidateLanguageCache();
                saveSettings();
            });
        }
    
    // ── Custom hybrid lenses ────────────────────────────────────────────────────
    // Each row: [✓ active] [name input] [edit ✎ toggles textarea] [delete ✕].
    // A custom lens contributes "### Lens: <name>\n<prompt>" to the assembled
    // hybrid prompt (see _buildHybridPrompt). {{OUTPUT_LANGUAGE}} is the only
    // token substituted inside the prompt body — no {{TARGET_LANG_*}}/{{CEFR_*}}.
    
    function _newLensId() {
        try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
        return 'cl' + Date.now().toString(36);
    }
    
    function _mutateCustomLens(fn) {
        if (!Array.isArray(S().customLenses)) S().customLenses = [];
        fn(S().customLenses);
        deps.invalidateLanguageCache();
        saveSettings();
    }
    
    function renderCustomLenses(listEl) {
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
    
            // Edit button (toggles the textarea below the row)
            const editBtn = document.createElement('div');
            editBtn.className = 'menu_button menu_button_icon';
            editBtn.title = t('Edit prompt');
            editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
    
            const bodyWrap = document.createElement('div');
            bodyWrap.className = 'gls-s-custom-lens-prompt';
            bodyWrap.hidden = true;
            const body = document.createElement('textarea');
            body.className = 'text_pole gls-s-resize-v';
            body.rows = 4;
            body.value = c.prompt || '';
            body.placeholder = t('Voice + when to footnote + label + format. Supports {{OUTPUT_LANGUAGE}}.');
            on(body, 'input', () => _mutateCustomLens(arr => { arr[i].prompt = body.value; }));
            bodyWrap.appendChild(body);
    
            on(editBtn, 'click', () => {
                const open = bodyWrap.hidden;
                bodyWrap.hidden = !open;
                if (open) body.focus();
            });
    
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
            row.appendChild(bodyWrap);
            listEl.appendChild(row);
        });
    }
}
