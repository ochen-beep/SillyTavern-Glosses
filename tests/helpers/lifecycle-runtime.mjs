// @ts-check
/**
 * Controllable browser runtime for lifecycle/teardown tests.
 *
 * Ported 1:1 from DS Comments/test-helpers/lifecycle-runtime.mjs. Installs
 * EventTarget-like window/document, fake ResizeObserver/MutationObserver, and
 * explicit timer/raf queues. Use `install()` BEFORE importing the module under
 * test and `uninstall()` in a cleanup hook to avoid leaking globals to other
 * tests.
 */

import '../tests/helpers/stub-runtime.mjs';

let _originals = null;

function makeListenerBag() {
    const listeners = new Map();
    return {
        add(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        remove(name, fn) {
            const arr = listeners.get(name);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
        },
        count(name) { return listeners.get(name)?.length || 0; },
        get(name) { return listeners.get(name) ? [...listeners.get(name)] : []; },
        fire(name, event = { type: name }) {
            const arr = listeners.get(name);
            if (!arr) return;
            for (const fn of [...arr]) fn(event);
        },
        clear() { listeners.clear(); },
    };
}

function parseHtmlChildren(html, parent) {
    const children = [];
    const stack = [];
    const tagRegex = /<\/?([a-z0-9]+)([^>]*)>/gi;
    let match;
    while ((match = tagRegex.exec(html)) !== null) {
        const [full, tag, attrs] = match;
        const isClose = full[1] === '/';
        if (isClose) {
            stack.pop();
            continue;
        }
        const id = (attrs.match(/id="([^"]+)"/) || [])[1] || '';
        const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
        const el = makeFakeElement(tag, id);
        el.className = cls;
        if (stack.length) stack[stack.length - 1].appendChild(el);
        else children.push(el);
        stack.push(el);
    }
    return children;
}

function makeFakeElement(tag = 'div', id = '') {
    const listeners = makeListenerBag();
    const style = {
        setProperty(name, value) { this[name] = String(value); },
        removeProperty(name) { const value = this[name] || ''; delete this[name]; return value; },
    };
    const dataset = {};
    const classList = new Set();
    let _rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    let _innerHTML = '';
    const el = {
        tagName: tag.toUpperCase(),
        id,
        className: '',
        classList: {
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            toggle: (c, force) => {
                const has = classList.has(c);
                if (force === true || (force === undefined && !has)) { classList.add(c); return true; }
                classList.delete(c);
                return false;
            },
            contains: (c) => classList.has(c),
        },
        style,
        dataset,
        hidden: false,
        get innerHTML() { return _innerHTML; },
        set innerHTML(v) {
            _innerHTML = String(v ?? '');
            this.children.length = 0;
            if (!_innerHTML) return;
            const parsed = parseHtmlChildren(_innerHTML, this);
            for (const c of parsed) {
                this.children.push(c);
                c.parentElement = this;
            }
        },
        textContent: '',
        value: '',
        tabIndex: 0,
        children: [],
        parentElement: null,
        _rect,
        setRect(r) { Object.assign(_rect, r); },
        getBoundingClientRect() { return { ..._rect }; },
        addEventListener: (name, fn) => listeners.add(name, fn),
        removeEventListener: (name, fn) => listeners.remove(name, fn),
        dispatchEvent: (e) => listeners.fire(e.type, e),
        querySelector(sel) {
            if (sel.startsWith('#')) {
                for (const c of this.children) if (c.id === sel.slice(1)) return c;
                for (const c of this.children) { const r = c.querySelector(sel); if (r) return r; }
                return null;
            }
            return null;
        },
        querySelectorAll(sel) {
            if (sel.startsWith('#')) {
                const r = this.querySelector(sel);
                return r ? [r] : [];
            }
            return [];
        },
        closest: () => null,
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; },
        contains(child) { return this.children.includes(child); },
        getAttribute: (name) => (name === 'id' ? this.id : undefined),
        setAttribute: () => {},
    };
    return el;
}

export const fakeVisualViewport = {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    _listeners: makeListenerBag(),
    addEventListener(name, fn) { this._listeners.add(name, fn); },
    removeEventListener(name, fn) { this._listeners.remove(name, fn); },
    listenerCount(name) { return this._listeners.count(name); },
    dispatchEvent(e) { this._listeners.fire(e.type, e); },
};

export const fakeWindow = {
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: fakeVisualViewport,
    _listeners: makeListenerBag(),
    addEventListener(name, fn) { this._listeners.add(name, fn); },
    removeEventListener(name, fn) { this._listeners.remove(name, fn); },
    listenerCount(name) { return this._listeners.count(name); },
    dispatchEvent(e) { this._listeners.fire(e.type, e); },
    getComputedStyle(el, _pseudo) {
        return {
            getPropertyValue: (prop) => (el.style && el.style[prop] !== undefined ? String(el.style[prop]) : ''),
        };
    },
};

const _elements = new Map();
export const fakeDocument = {
    body: makeFakeElement('body', ''),
    documentElement: makeFakeElement('html', ''),
    _listeners: makeListenerBag(),
    addEventListener(name, fn) { this._listeners.add(name, fn); },
    removeEventListener(name, fn) { this._listeners.remove(name, fn); },
    listenerCount(name) { return this._listeners.count(name); },
    dispatchEvent(e) { this._listeners.fire(e.type, e); },
    getElementById(id) {
        if (_elements.has(id)) return _elements.get(id);
        function find(el) {
            if (!el || !el.children) return null;
            for (const c of el.children) {
                if (c.id === id) return c;
                const r = find(c);
                if (r) return r;
            }
            return null;
        }
        return find(this.body) || find(this.documentElement) || null;
    },
    createElement(tag) {
        return makeFakeElement(tag);
    },
    querySelector(sel) {
        if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
        for (const el of _elements.values()) if (el.classList.contains(sel.replace('.', ''))) return el;
        return null;
    },
    querySelectorAll(sel) {
        if (sel.startsWith('#')) return [this.getElementById(sel.slice(1))].filter(Boolean);
        return [..._elements.values()].filter(el => el.classList.contains(sel.replace('.', '')));
    },
};

export function registerElement(id, el) {
    el.id = id;
    _elements.set(id, el);
}
export function clearElements() { _elements.clear(); }

let _timeoutId = 1;
const _timeouts = new Map();
const _intervals = new Map();
export const clock = {
    setTimeout(fn, delay, ...args) {
        const id = _timeoutId++;
        _timeouts.set(id, { fn, delay, args, id });
        return id;
    },
    clearTimeout(id) { _timeouts.delete(id); },
    setInterval(fn, delay, ...args) {
        const id = _timeoutId++;
        _intervals.set(id, { fn, delay, args, id });
        return id;
    },
    clearInterval(id) { _intervals.delete(id); },
    pendingTimeouts() { return _timeouts.size; },
    pendingIntervals() { return _intervals.size; },
    pending() { return this.pendingTimeouts() + this.pendingIntervals(); },
    runAll() {
        for (const { fn, args } of _timeouts.values()) fn(...args);
        _timeouts.clear();
    },
    reset() { _timeouts.clear(); _intervals.clear(); _timeoutId = 1; },
};

let _rafId = 1;
const _rafQueue = new Map();
export const raf = {
    request(fn) {
        const id = _rafId++;
        _rafQueue.set(id, fn);
        return id;
    },
    cancel(id) { _rafQueue.delete(id); },
    pending() { return _rafQueue.size; },
    runAll() {
        for (const fn of _rafQueue.values()) fn();
        _rafQueue.clear();
    },
    reset() { _rafQueue.clear(); _rafId = 1; },
};

const _resizeObservers = [];
export class FakeResizeObserver {
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.disconnectCalls = 0;
        _resizeObservers.push(this);
    }
    observe(el) { this.observed.push(el); }
    disconnect() { this.disconnectCalls++; this.observed = []; }
    simulate() { this.callback(this.observed.map(target => ({ target }))); }
}

const _mutationObservers = [];
export class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.disconnectCalls = 0;
        _mutationObservers.push(this);
    }
    observe(el, _opts) { this.observed.push(el); }
    disconnect() { this.disconnectCalls++; this.observed = []; }
    simulate(records) { this.callback(records); }
}
export const observers = {
    get resize() { return [..._resizeObservers]; },
    get mutation() { return [..._mutationObservers]; },
    reset() { _resizeObservers.length = 0; _mutationObservers.length = 0; },
};

function debounceWithCancel(fn, wait) {
    let timer = null;
    function wrapped(...args) {
        if (timer) clock.clearTimeout(timer);
        timer = clock.setTimeout(() => { timer = null; fn(...args); }, wait);
    }
    wrapped.cancel = () => { if (timer) { clock.clearTimeout(timer); timer = null; } };
    wrapped.flush = () => { if (timer) { const t = timer; clock.clearTimeout(timer); timer = null; _timeouts.get(t)?.fn(); } };
    return wrapped;
}

export function install() {
    if (_originals) uninstall();
    _originals = {
        window: globalThis.window,
        document: globalThis.document,
        ResizeObserver: globalThis.ResizeObserver,
        MutationObserver: globalThis.MutationObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        setTimeout: globalThis.setTimeout,
        setInterval: globalThis.setInterval,
        clearTimeout: globalThis.clearTimeout,
        clearInterval: globalThis.clearInterval,
        windowVisualViewport: fakeWindow.visualViewport,
        debounce: globalThis.SillyTavern?.libs?.lodash?.debounce,
    };

    globalThis.window = fakeWindow;
    globalThis.document = fakeDocument;
    globalThis.ResizeObserver = FakeResizeObserver;
    globalThis.MutationObserver = FakeMutationObserver;
    globalThis.requestAnimationFrame = raf.request.bind(raf);
    globalThis.cancelAnimationFrame = raf.cancel.bind(raf);
    globalThis.setTimeout = clock.setTimeout.bind(clock);
    globalThis.setInterval = clock.setInterval.bind(clock);
    globalThis.clearTimeout = clock.clearTimeout.bind(clock);
    globalThis.clearInterval = clock.clearInterval.bind(clock);
    if (globalThis.SillyTavern?.libs?.lodash) {
        globalThis.SillyTavern.libs.lodash.debounce = debounceWithCancel;
    }

    fakeWindow._listeners.clear();
    fakeVisualViewport._listeners.clear();
    fakeWindow.visualViewport = fakeVisualViewport;
    fakeWindow.innerWidth = 1024;
    fakeWindow.innerHeight = 768;
    fakeVisualViewport.width = fakeWindow.innerWidth;
    fakeVisualViewport.height = fakeWindow.innerHeight;
    fakeVisualViewport.offsetLeft = 0;
    fakeVisualViewport.offsetTop = 0;
    fakeDocument._listeners.clear();
    clearElements();
    clock.reset();
    raf.reset();
    observers.reset();
}

export function uninstall() {
    if (!_originals) return;
    fakeWindow.visualViewport = _originals.windowVisualViewport;
    fakeWindow._listeners.clear();
    fakeVisualViewport._listeners.clear();
    fakeWindow.innerWidth = 1024;
    fakeWindow.innerHeight = 768;
    fakeVisualViewport.width = fakeWindow.innerWidth;
    fakeVisualViewport.height = fakeWindow.innerHeight;
    fakeVisualViewport.offsetLeft = 0;
    fakeVisualViewport.offsetTop = 0;
    globalThis.window = _originals.window;
    globalThis.document = _originals.document;
    globalThis.ResizeObserver = _originals.ResizeObserver;
    globalThis.MutationObserver = _originals.MutationObserver;
    globalThis.requestAnimationFrame = _originals.requestAnimationFrame;
    globalThis.cancelAnimationFrame = _originals.cancelAnimationFrame;
    globalThis.setTimeout = _originals.setTimeout;
    globalThis.setInterval = _originals.setInterval;
    globalThis.clearTimeout = _originals.clearTimeout;
    globalThis.clearInterval = _originals.clearInterval;
    if (globalThis.SillyTavern?.libs?.lodash && _originals.debounce) {
        globalThis.SillyTavern.libs.lodash.debounce = _originals.debounce;
    }
    _originals = null;
    clearElements();
    clock.reset();
    raf.reset();
    observers.reset();
}
