import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATIC_HTML_CSP, STATIC_HTML_CSP_META, STATIC_HTML_DOCUMENT_START } from "./htmlSandbox";
import { SandboxedHtml } from "./SandboxedHtml";
import { TextPreview } from "./StaticPreview";

const prepareCalls = { n: 0 };

vi.mock("./htmlSandbox", async () => {
  const actual = await vi.importActual<typeof import("./htmlSandbox")>("./htmlSandbox");
  return {
    ...actual,
    prepareStaticHtml(input: string) {
      prepareCalls.n += 1;
      return actual.prepareStaticHtml(input);
    },
  };
});

type ShimNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: ShimNode[];
  parentNode: ShimNode | null;
  ownerDocument: ShimDoc | null;
  data: string;
  textContent: string;
  srcdoc: string;
  namespaceURI: string;
  style: object;
  appendChild: (child: ShimNode) => ShimNode;
  insertBefore: (child: ShimNode, ref: ShimNode | null) => ShimNode;
  removeChild: (child: ShimNode) => ShimNode;
  setAttribute: (name: string, value: string) => void;
  setAttributeNS: (ns: string | null, name: string, value: string) => void;
  removeAttribute: () => void;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
  contains: (child: ShimNode) => boolean;
  getRootNode: () => ShimDoc;
  compareDocumentPosition: () => number;
  getBoundingClientRect: () => { top: number; left: number; width: number; height: number };
  cloneNode: () => ShimNode;
  hasChildNodes: () => boolean;
  replaceChild: (next: ShimNode, prev: ShimNode) => ShimNode;
  firstChild: ShimNode | null;
  lastChild: ShimNode | null;
  nextSibling: ShimNode | null;
};

type ShimDoc = {
  nodeType: number;
  nodeName: string;
  documentElement: ShimNode;
  body: ShimNode;
  head: ShimNode;
  defaultView: object;
  createElement: (name: string) => ShimNode;
  createElementNS: (ns: string, name: string) => ShimNode;
  createTextNode: (text: string) => ShimNode;
  createComment: (text: string) => ShimNode;
  createDocumentFragment: () => ShimNode;
  querySelector: () => null;
  querySelectorAll: () => never[];
  getElementById: () => null;
  addEventListener: () => void;
  removeEventListener: () => void;
};

function installDom(): { doc: ShimDoc; host: ShimNode } {
  function make(name: string): ShimNode {
    const kids: ShimNode[] = [];
    const el = {
      nodeType: name === "#text" ? 3 : name === "#fragment" ? 11 : 1,
      nodeName: name === "#text" || name === "#comment" || name === "#fragment" ? name : name.toUpperCase(),
      tagName: name.toUpperCase(),
      childNodes: kids,
      parentNode: null as ShimNode | null,
      ownerDocument: null,
      data: "",
      textContent: "",
      srcdoc: "",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      style: new Proxy({}, { get: () => () => "", set: () => true }),
      appendChild(child: ShimNode) {
        child.parentNode = el;
        kids.push(child);
        return child;
      },
      insertBefore(child: ShimNode, ref: ShimNode | null) {
        child.parentNode = el;
        const index = ref ? kids.indexOf(ref) : -1;
        if (index < 0) kids.push(child);
        else kids.splice(index, 0, child);
        return child;
      },
      removeChild(child: ShimNode) {
        const index = kids.indexOf(child);
        if (index >= 0) kids.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(attr: string, value: string) {
        (el as unknown as Record<string, string>)[attr] = String(value);
      },
      setAttributeNS(_ns: string | null, attr: string, value: string) {
        el.setAttribute(attr, value);
      },
      removeAttribute() {},
      getAttribute(attr: string) {
        const record = el as unknown as Record<string, unknown>;
        return Object.prototype.hasOwnProperty.call(record, attr) ? String(record[attr]) : null;
      },
      hasAttribute(attr: string) {
        return Object.prototype.hasOwnProperty.call(el, attr);
      },
      addEventListener() {},
      removeEventListener() {},
      contains(child: ShimNode) {
        return kids.includes(child);
      },
      getRootNode() {
        return doc;
      },
      compareDocumentPosition() {
        return 0;
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
      },
      cloneNode() {
        return make(name);
      },
      hasChildNodes() {
        return kids.length > 0;
      },
      replaceChild(next: ShimNode, prev: ShimNode) {
        const index = kids.indexOf(prev);
        if (index >= 0) kids[index] = next;
        next.parentNode = el;
        return prev;
      },
      get firstChild() {
        return kids[0] ?? null;
      },
      get lastChild() {
        return kids[kids.length - 1] ?? null;
      },
      get nextSibling() {
        const parent = el.parentNode;
        if (!parent) return null;
        const index = parent.childNodes.indexOf(el);
        return parent.childNodes[index + 1] ?? null;
      },
    };
    return el;
  }
  const doc = {
    nodeType: 9,
    nodeName: "#document",
    documentElement: null as unknown as ShimNode,
    body: null as unknown as ShimNode,
    head: null as unknown as ShimNode,
    defaultView: null as unknown as object,
    createElement(name: string) {
      const el = make(name);
      el.ownerDocument = doc;
      return el;
    },
    createElementNS(_ns: string, name: string) {
      return doc.createElement(name);
    },
    createTextNode(text: string) {
      const el = make("#text");
      el.data = String(text);
      el.textContent = String(text);
      el.ownerDocument = doc;
      return el;
    },
    createComment(text: string) {
      const el = doc.createTextNode(text);
      el.nodeName = "#comment";
      el.nodeType = 8;
      return el;
    },
    createDocumentFragment() {
      const el = make("#fragment");
      el.ownerDocument = doc;
      return el;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  } as ShimDoc;
  doc.documentElement = doc.createElement("html");
  doc.head = doc.createElement("head");
  doc.body = doc.createElement("body");
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  class HTMLElement {}
  class Element {}
  class Node {}
  class HTMLIFrameElement extends HTMLElement {}
  const view = {
    document: doc,
    HTMLElement,
    Element,
    Node,
    HTMLIFrameElement,
    navigator: { userAgent: "node" },
    getSelection: () => null,
    requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => new Proxy({}, { get: () => () => "" }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    CSS: { supports: () => false },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    location: { href: "http://localhost/", protocol: "http:" },
    event: undefined,
  };
  doc.defaultView = view;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    HTMLIFrameElement: (globalThis as { HTMLIFrameElement?: unknown }).HTMLIFrameElement,
    MutationObserver: globalThis.MutationObserver,
  };
  Object.assign(globalThis, {
    window: view,
    document: doc,
    HTMLElement,
    Element,
    Node,
    HTMLIFrameElement,
    MutationObserver: view.MutationObserver,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installDom.restore = () => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.Element = previous.Element;
    globalThis.Node = previous.Node;
    (globalThis as { HTMLIFrameElement?: unknown }).HTMLIFrameElement = previous.HTMLIFrameElement;
    globalThis.MutationObserver = previous.MutationObserver;
  };
  return { doc, host: doc.createElement("div") };
}

installDom.restore = () => {};

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  installDom.restore();
});

function decodeSrcDoc(markup: string): string {
  const srcdoc = /srcDoc="([^"]*)"/.exec(markup)?.[1] ?? "";
  return srcdoc
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("SandboxedHtml", () => {
  it("renders an empty sandbox and puts the CSP meta in srcdoc", () => {
    const body = renderToStaticMarkup(
      createElement(SandboxedHtml, {
        text: "<p>hi</p><script>bad()</script>",
        source: createElement(TextPreview, { text: "<p>hi</p>", note: null }),
      }),
    );
    expect(body).toContain('sandbox=""');
    expect(body).not.toContain("allow-scripts");
    expect(body).not.toContain("allow-same-origin");
    const decoded = decodeSrcDoc(body);
    expect(decoded.startsWith(STATIC_HTML_DOCUMENT_START)).toBe(true);
    const headAt = decoded.indexOf("<head>");
    expect(decoded.slice(headAt + "<head>".length).startsWith(STATIC_HTML_CSP_META)).toBe(true);
    expect(decoded).toContain(STATIC_HTML_CSP);
    expect(decoded).toContain("<script>bad()</script>");
    expect(decoded).toContain("<p>hi</p>");
  });

  it("prepares the same html text once across renders", async () => {
    const { doc, host } = installDom();
    doc.body.appendChild(host);
    let bump = (_next: number) => {};
    function Harness({ text }: { text: string }) {
      const [tick, setTick] = useState(0);
      bump = setTick;
      return createElement(SandboxedHtml, {
        text,
        source: createElement("pre", null, String(tick)),
      });
    }
    prepareCalls.n = 0;
    const root: Root = createRoot(host as unknown as HTMLElement);
    await act(async () => {
      root.render(createElement(Harness, { text: "<p>hi</p><a href=\"https://example.com/memo\">x</a>" }));
    });
    expect(prepareCalls.n).toBe(1);
    await act(async () => {
      bump(1);
    });
    expect(prepareCalls.n).toBe(1);
    await act(async () => {
      root.unmount();
    });
  });
});
