import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabController } from '../src/ui/tabs.js';

test('tabs select footnotes by default and persist valid selection', () => {
    const persisted = [];
    const rendered = [];
    const c = createTabController({ getPersistedTab: () => 'missing', persistTab: id => persisted.push(id), onChange: tab => rendered.push(tab.id) });
    c.registerTab({ id: 'footnotes', label: 'Footnotes', render: () => {} });
    c.registerTab({ id: 'targeted', label: 'Targeted', render: () => {} });
    assert.equal(c.resolveInitialTab(), 'footnotes');
    assert.equal(c.setActiveTab('targeted'), true);
    assert.equal(c.getActiveTab(), 'targeted');
    assert.deepEqual(persisted, ['targeted']);
    assert.deepEqual(rendered, ['targeted']);
});

test('persisted valid tab wins and unknown tabs are no-ops', () => {
    const c = createTabController({ getPersistedTab: () => 'exclusions' });
    c.registerTab({ id: 'footnotes', label: 'Footnotes', render: () => {} });
    c.registerTab({ id: 'exclusions', label: 'Exclusions', render: () => {} });
    assert.equal(c.resolveInitialTab(), 'exclusions');
    assert.equal(c.setActiveTab('unknown'), false);
    assert.equal(c.getActiveTab(), 'exclusions');
});

test('refresh renders active tab and render/persist flags are honored', () => {
    const rendered = [];
    const persisted = [];
    const c = createTabController({ persistTab: id => persisted.push(id), onChange: tab => rendered.push(tab.id) });
    c.registerTab({ id: 'footnotes', label: 'Footnotes', render: () => {} });
    c.registerTab({ id: 'targeted', label: 'Targeted', render: () => {} });
    c.setActiveTab('targeted', { persist: false, render: false });
    assert.deepEqual(rendered, []);
    assert.deepEqual(persisted, []);
    c.refreshActiveTab();
    assert.deepEqual(rendered, ['targeted']);
});

test('scroll position is saved per tab', () => {
    let scrollTop = 4;
    const c = createTabController({ getScrollTop: () => scrollTop, setScrollTop: value => { scrollTop = value; } });
    c.registerTab({ id: 'footnotes', label: 'Footnotes', render: () => {} });
    c.registerTab({ id: 'targeted', label: 'Targeted', render: () => {} });
    scrollTop = 88;
    c.setActiveTab('targeted');
    scrollTop = 12;
    c.setActiveTab('footnotes');
    assert.equal(scrollTop, 88);
});

test('renderTabButtons stamps data-i18n from labelKey for host-side translation', () => {
    // Minimal fake DOM surface for renderTabButtons (repo convention: no jsdom).
    const makeButton = () => ({
        dataset: {},
        attrs: {},
        listeners: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    });
    const container = {
        innerHTML: 'stale',
        ownerDocument: { createElement: makeButton },
        children: [],
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(b) { this.children.push(b); },
    };
    const c = createTabController({});
    c.registerTab({ id: 'footnotes', label: 'Footnotes', labelKey: 'Footnotes', render: () => {} });
    c.registerTab({ id: 'targeted', label: 'Targeted', labelKey: 'Targeted', render: () => {} });
    c.registerTab({ id: 'exclusions', label: 'Exclusions', render: () => {} });
    const buttons = c.renderTabButtons(container, { panelId: 'body-id' });

    assert.equal(container.innerHTML, '', 'container is cleared');
    assert.equal(container.attrs.role, 'tablist');
    assert.equal(buttons.length, 3);
    assert.deepEqual(container.children, buttons, 'buttons are appended in registration order');
    // The i18n contract: ST's MutationObserver translates [data-i18n] nodes on
    // insert, so the raw English key must ride on the attribute even though
    // textContent carries whatever t() produced at build time.
    assert.equal(buttons[0].dataset.i18n, 'Footnotes');
    assert.equal(buttons[1].dataset.i18n, 'Targeted');
    assert.equal(buttons[2].dataset.i18n, undefined, 'no labelKey — no data-i18n stamp');
    assert.equal(buttons[0].textContent, 'Footnotes');
    assert.equal(buttons[0].id, 'gls-tab-footnotes');
    assert.equal(buttons[0].dataset.tabId, 'footnotes');
    assert.equal(buttons[0].attrs['aria-selected'], 'true', 'default tab is active');
    assert.equal(buttons[1].attrs['aria-selected'], 'false');
    assert.equal(buttons[0].attrs['aria-controls'], 'body-id');
    // A click on a button activates its tab through the controller.
    let changed = null;
    const c2 = createTabController({ onChange: tab => { changed = tab.id; } });
    const container2 = { ...container, children: [], attrs: {}, innerHTML: '' };
    c2.registerTab({ id: 'footnotes', label: 'Footnotes', labelKey: 'Footnotes', render: () => {} });
    c2.registerTab({ id: 'targeted', label: 'Targeted', labelKey: 'Targeted', render: () => {} });
    const btns2 = c2.renderTabButtons(container2);
    btns2[1].listeners.click[0]();
    assert.equal(changed, 'targeted');
    assert.equal(c2.getActiveTab(), 'targeted');
    assert.equal(btns2[1].attrs['aria-selected'], 'true', 'syncButtons updates the strip');
    assert.equal(btns2[0].attrs['aria-selected'], 'false');
});
