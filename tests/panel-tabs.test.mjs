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
