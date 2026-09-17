// @ts-check
/**
 * Minimal DOM shim for the renderer's marker-injection path (wrapAnchors /
 * wrapSegment / createMarker / removeHighlights / buildTextIndex).
 *
 * The repo's test philosophy is "intentionally no jsdom" (see stub-runtime.mjs);
 * this shim stays inside that philosophy: just enough surface for the marker
 * wrap path to run under Node — text nodes, elements, splitText, normalize,
 * replaceChild, classList/dataset, a small selector engine, and a text-only
 * TreeWalker. Import it AFTER stub-runtime.mjs (it overwrites the placeholder
 * document) and BEFORE importing src/renderer.js.
 *
 * Modeled on the production shape that triggers the multi-piece marker: ST's
 * markdown wraps «…» / "…" quotes in <q>, so an anchor that spans a quote
 * crosses a text-node boundary mid-phrase.
 */

export const TEXT_NODE = 3;
export const ELEMENT_NODE = 1;

export class MiniText {
    nodeType = TEXT_NODE;
    constructor(value) {
        this.nodeValue = String(value ?? '');
        this.parentNode = null;
        this.childNodes = [];
    }
    get nextSibling() {
        const s = this.parentNode?.childNodes ?? [];
        const i = s.indexOf(this);
        return i >= 0 ? (s[i + 1] ?? null) : null;
    }
    get previousSibling() {
        const s = this.parentNode?.childNodes ?? [];
        const i = s.indexOf(this);
        return i >= 1 ? s[i - 1] : null;
    }
    splitText(offset) {
        const tail = this.nodeValue.slice(offset);
        this.nodeValue = this.nodeValue.slice(0, offset);
        const node = new MiniText(tail);
        const i = this.parentNode.childNodes.indexOf(this);
        this.parentNode.childNodes.splice(i + 1, 0, node);
        node.parentNode = this.parentNode;
        return node;
    }
}

export class MiniElement {
    nodeType = ELEMENT_NODE;
    constructor(tag) {
        this.tagName = String(tag ?? 'div').toUpperCase();
        this.parentNode = null;
        this.childNodes = [];
        this._classes = new Set();
        this._html = '';
        this.dataset = {};
        this.attributes = {};
    }
    // ── classes / attributes ──
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }
    get classList() {
        const s = this._classes;
        return {
            add: (...names) => names.forEach(n => s.add(n)),
            remove: (...names) => names.forEach(n => s.delete(n)),
            contains: n => s.has(n),
            toggle: (n, force) => {
                const on = force === undefined ? !s.has(n) : Boolean(force);
                if (on) s.add(n); else s.delete(n);
                return on;
            },
        };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    // ── tree ──
    appendChild(child) {
        if (child.parentNode) {
            const siblings = child.parentNode.childNodes;
            siblings.splice(siblings.indexOf(child), 1);
        }
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }
    replaceChild(next, prev) {
        const i = this.childNodes.indexOf(prev);
        if (i < 0) throw new Error('replaceChild: reference node not found');
        if (next.parentNode) {
            const s = next.parentNode.childNodes;
            s.splice(s.indexOf(next), 1);
        }
        this.childNodes[i] = next;
        next.parentNode = this;
        prev.parentNode = null;
        return prev;
    }
    remove() {
        if (this.parentNode) this.parentNode.replaceChild(new MiniText(''), this);
    }
    /** Merge adjacent text children, depth-first (DOM Spec behavior). */
    normalize() {
        for (const c of this.childNodes) {
            if (c instanceof MiniElement) c.normalize();
        }
        for (let i = 0; i < this.childNodes.length - 1;) {
            const a = this.childNodes[i];
            const b = this.childNodes[i + 1];
            if (a instanceof MiniText && b instanceof MiniText) {
                a.nodeValue += b.nodeValue;
                this.childNodes.splice(i + 1, 1);
            } else {
                i += 1;
            }
        }
    }
    // ── text/html ──
    get textContent() {
        if (!this.childNodes.length) return this._html.replace(/<[^>]+>/g, '');
        let out = '';
        const walk = n => {
            for (const c of n.childNodes) {
                if (c instanceof MiniText) out += c.nodeValue;
                else walk(c);
            }
        };
        walk(this);
        return out;
    }
    set textContent(v) {
        this.childNodes.length = 0;
        this._html = '';
        if (v !== '') this.appendChild(new MiniText(v));
    }
    get innerText() { return this.textContent; }
    get innerHTML() {
        if (!this.childNodes.length) return this._html;
        const ser = n => n instanceof MiniText
            ? n.nodeValue
            : `<${n.tagName.toLowerCase()}${n.className ? ` class="${n.className}"` : ''}>${n.childNodes.map(ser).join('')}</${n.tagName.toLowerCase()}>`;
        return this.childNodes.map(ser).join('');
    }
    set innerHTML(v) {
        this.childNodes.length = 0;
        this._html = String(v ?? '');
    }
    // ── traversal helpers ──
    contains(other) {
        for (let n = other; n; n = n.parentNode) {
            if (n === this) return true;
        }
        return false;
    }
    get parentElement() {
        return this.parentNode instanceof MiniElement ? this.parentNode : null;
    }
    *descendants() {
        for (const c of this.childNodes) {
            yield c;
            if (c instanceof MiniElement) yield* c.descendants();
        }
    }
    // ── selector engine (subset: comma list of descendant/child chains) ──
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    querySelectorAll(sel) {
        const out = [];
        for (const chain of String(sel).split(',')) {
            for (const el of this.descendants()) {
                if (el instanceof MiniElement && matchChain(el, chain.trim(), this)) out.push(el);
            }
        }
        return [...new Set(out)];
    }
}

// A chain is space/`>`-separated compound tokens (tag and/or .classes),
// optionally anchored with a leading ':scope' (this element) or ':scope >'.
function matchChain(el, chain, scope) {
    const parts = chain.split(/\s+/).filter(Boolean);
    let i = parts.length - 1;
    if (parts[i] === '>') return false;
    if (!matchCompound(el, parts[i])) return false;
    let node = el.parentNode;
    i -= 1;
    while (i >= 0) {
        if (parts[i] === '>') {
            i -= 1;
            if (i < 0) return node === scope;
            if (!(node instanceof MiniElement) || !matchCompound(node, parts[i])) return false;
            node = node.parentNode;
            i -= 1;
            continue;
        }
        // descendant combinator: climb until a compound matches (or scope wall)
        while (node && node !== scope && !(node instanceof MiniElement && matchCompound(node, parts[i]))) {
            node = node.parentNode;
        }
        if (!(node instanceof MiniElement)) return false;
        node = node.parentNode;
        i -= 1;
    }
    return true;
}

function matchCompound(el, token) {
    if (token === ':scope') return el === el; // handled by caller context via scope wall
    const m = token.match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
    return classes.every(c => el._classes.has(c));
}

/** A tiny document over MiniElement/MiniText with the surfaces the wrap path uses. */
export function createMiniDocument() {
    const doc = new MiniElement('#document');
    return {
        documentElement: doc,
        body: doc.appendChild(new MiniElement('body')),
        createElement: tag => new MiniElement(tag),
        createTextNode: text => new MiniText(text),
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        createTreeWalker(root) {
            const nodes = [];
            (function walk(n) {
                for (const c of n.childNodes) {
                    if (c instanceof MiniText) nodes.push(c);
                    else walk(c);
                }
            })(root);
            let i = 0;
            return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
        },
    };
}

/** Install globals (Node/NodeFilter/document) needed by the marker wrap path. */
export function installMiniDom() {
    globalThis.Node = globalThis.Node ?? {
        TEXT_NODE,
        ELEMENT_NODE,
    };
    globalThis.NodeFilter = globalThis.NodeFilter ?? {
        SHOW_TEXT: 4,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
    };
    globalThis.document = createMiniDocument();
    return globalThis.document;
}

/** Convenience: element with classes. */
export function el(tag, classes, ...children) {
    const node = new MiniElement(tag);
    if (classes) node.className = classes;
    for (const c of children) node.appendChild(c);
    return node;
}

export function txt(value) {
    return new MiniText(value);
}
