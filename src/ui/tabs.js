// @ts-check
/**
 * Small controller for the floating panel's tab strip.
 *
 * DOM rendering is intentionally supplied by the caller. This keeps tab state
 * usable in Node tests and prevents the controller from knowing panel layout.
 */

const DEFAULT_TAB = 'footnotes';

function noop() {}

/**
 * @param {{
 *   getPersistedTab?: () => string | null,
 *   persistTab?: (id: string) => void,
 *   onChange?: (tab: { id: string, label: string, render: Function }) => void,
 *   getScrollTop?: () => number,
 *   setScrollTop?: (value: number) => void,
 * }} [options]
 */
export function createTabController(options = {}) {
    const tabs = new Map();
    const scroll = new Map();
    const getPersistedTab = options.getPersistedTab || (() => null);
    const persistTab = options.persistTab || noop;
    const onChange = options.onChange || noop;
    const getScrollTop = options.getScrollTop || (() => 0);
    const setScrollTop = options.setScrollTop || noop;
    let activeId = null;
    let renderedButtons = [];

    function syncButtons() {
        for (const button of renderedButtons) {
            const id = button.dataset.tabId;
            const active = id === activeId;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        }
    }
    function registerTab({ id, label, labelKey, render }) {
        if (!id || typeof render !== 'function') throw new TypeError('tab id and render are required');
        const tab = {
            id: String(id),
            label: String(label ?? id),
            // Raw (English) translation key. renderTabButtons stamps it as
            // data-i18n so ST's own i18n MutationObserver re-translates the
            // button on insert — host-side localization that works even when
            // the label was produced by t() before its translate surface
            // resolved (buildPanel runs in one sync block at boot).
            labelKey: labelKey != null ? String(labelKey) : null,
            render,
        };
        tabs.set(tab.id, tab);
        // Resolve only after the registry has all tabs. This lets persisted
        // targeted/exclusions selections win when those tabs register later.
        return tab;
    }

    function resolveInitialTab() {
        const persisted = String(getPersistedTab() || '');
        if (persisted && tabs.has(persisted)) return persisted;
        if (tabs.has(DEFAULT_TAB)) return DEFAULT_TAB;
        return tabs.keys().next().value || DEFAULT_TAB;
    }

    function setActiveTab(id, { persist = true, render = true } = {}) {
        if (!activeId) activeId = resolveInitialTab();
        const next = String(id || '');
        if (!tabs.has(next)) return false;
        if (activeId && activeId !== next) scroll.set(activeId, Number(getScrollTop()) || 0);
        activeId = next;
        syncButtons();
        if (persist) persistTab(next);
        if (render) {
            onChange(tabs.get(next));
            setScrollTop(scroll.get(next) || 0);
        }
        return true;
    }

    function refreshActiveTab() {
        if (!activeId) activeId = resolveInitialTab();
        const tab = tabs.get(activeId);
        if (!tab) return false;
        onChange(tab);
        return true;
    }

    function renderTabButtons(container, { panelId = 'gls-panel-body' } = {}) {
        if (!container) return [];
        if (!activeId) activeId = resolveInitialTab();
        container.innerHTML = '';
        container.setAttribute?.('role', 'tablist');
        const buttons = [];
        for (const tab of tabs.values()) {
            const button = container.ownerDocument?.createElement?.('button') || document.createElement('button');
            button.type = 'button';
            button.id = `gls-tab-${tab.id}`;
            button.dataset.tabId = tab.id;
            button.textContent = tab.label;
            if (tab.labelKey) button.dataset.i18n = tab.labelKey;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(tab.id === activeId));
            button.setAttribute('aria-controls', panelId);
            button.tabIndex = tab.id === activeId ? 0 : -1;
            button.addEventListener('click', () => setActiveTab(tab.id));
            button.addEventListener('keydown', (event) => {
                const ids = [...tabs.keys()];
                const index = ids.indexOf(tab.id);
                let target = null;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = ids[(index + 1) % ids.length];
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = ids[(index - 1 + ids.length) % ids.length];
                if (event.key === 'Home') target = ids[0];
                if (event.key === 'End') target = ids[ids.length - 1];
                if (target) {
                    event.preventDefault();
                    setActiveTab(target);
                    const nextButton = buttons[ids.indexOf(target)];
                    nextButton?.focus?.();
                }
            });
            container.appendChild(button);
            buttons.push(button);
        }
        renderedButtons = buttons;
        syncButtons();
        return buttons;
    }

    return {
        registerTab,
        resolveInitialTab,
        setActiveTab,
        refreshActiveTab,
        renderTabButtons,
        getActiveTab: () => activeId,
    };
}
