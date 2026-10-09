import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");

/** DOM/layout boundary: exercise the real menu with controlled anchor and content sizes. */
function element(tag, document, contentHeight) {
  const node = {
    tag, className: "", children: [], style: {}, listeners: new Map(), parent: null,
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; },
    setAttribute() {},
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    matches(selector) { return selector.split(".").filter(Boolean).every((name) => this.className.split(" ").includes(name)); },
    focus() { document.activeElement = this; },
    get offsetHeight() { return Math.min(contentHeight, parseFloat(this.style.maxHeight ?? "Infinity")); },
    getBoundingClientRect() {
      const top = this.style.top ? parseFloat(this.style.top) : document.height - parseFloat(this.style.bottom) - this.offsetHeight;
      return { top, bottom: top + this.offsetHeight, height: this.offsetHeight };
    },
  };
  return node;
}

async function withMenu({ top = 16, bottom = 50, height = 800, contentHeight = 1500, modal = false } = {}, run) {
  const keys = ["document", "window", "matchMedia", "setTimeout"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const document = { height, activeElement: null, createElement: (tag) => element(tag, document, contentHeight) };
  document.body = element("body", document, contentHeight);
  document.querySelector = (selector) => document.body.querySelector(selector);
  globalThis.document = document;
  globalThis.window = { innerWidth: 1280, innerHeight: height };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.setTimeout = () => 0;
  try {
    const { openMenu } = await import("../lib/app/web/public/app/views/panels/panels.js");
    const host = modal ? element("dialog", document, contentHeight) : document.body;
    if (modal) document.body.append(host);
    const anchor = { getBoundingClientRect: () => ({ top, bottom, left: 100 }), closest: () => modal ? host : null, focus() {} };
    openMenu(anchor, [{ label: "First", run() {} }, { label: "Last", run() {} }]);
    await run(host.querySelector(".popup-menu"), document, host);
  } finally {
    for (const [index, key] of keys.entries()) if (previous[index]) Object.defineProperty(globalThis, key, previous[index]); else delete globalThis[key];
  }
}

function expectBounded(menu, height) {
  const rect = menu.getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(8);
  expect(rect.bottom).toBeLessThanOrEqual(height - 8);
}

describe("anchored menu placement", () => {
  it("keeps a tall top-bar project menu below its anchor and inside the viewport", async () => {
    await withMenu({}, (menu) => {
      expect(menu.getBoundingClientRect().top).toBe(56);
      expectBounded(menu, 800);
      expect(menu.style.maxHeight).toBe("736px");
    });
  });

  it("keeps a short menu below when it fits, even with more room above", async () => {
    await withMenu({ top: 500, bottom: 534, contentHeight: 100 }, (menu) => {
      expect(menu.getBoundingClientRect().top).toBe(540);
      expectBounded(menu, 800);
    });
  });

  it("opens a bottom-bar menu above and bounds oversized content there", async () => {
    for (const contentHeight of [100, 1500]) await withMenu({ top: 700, bottom: 734, contentHeight }, (menu) => {
      expect(menu.getBoundingClientRect().bottom).toBe(694);
      expectBounded(menu, 800);
    });
  });

  it("uses the roomier side when neither side fits in a short viewport", async () => {
    for (const top of [60, 160]) await withMenu({ top, bottom: top + 34, height: 300 }, (menu) => {
      expectBounded(menu, 300);
      expect(top === 60 ? menu.getBoundingClientRect().top : menu.getBoundingClientRect().bottom).toBe(top === 60 ? 100 : 154);
    });
  });

  it("keeps modal menus in the dialog and retains arrow-key navigation", async () => {
    await withMenu({ modal: true }, (menu, document, host) => {
      expect(menu.parent).toBe(host);
      expectBounded(menu, 800);
      menu.listeners.get("keydown")({ key: "ArrowDown", preventDefault() {} });
      expect(document.activeElement).toBe(menu.querySelectorAll(".menu-item")[1]);
    });
  });

  it("lets overflowing menu content scroll", () => {
    const rule = css.match(/\.popup-menu \{([^}]+)\}/)[1];
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
