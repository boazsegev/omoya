import { expect, test } from "bun:test";
import { session } from "../lib/app/web/public/app/orchestrators/session.js";

function context() {
  const invalidations = [];
  return { invalidations, state: { settings: { endpoint: null, model: null }, prefs: { theme: "dark", activeTheme: null, themes: ["custom"], themeModes: { custom: "light" }, collapse: { tools: true } } }, invalidate: (name) => invalidations.push(name) };
}

test("equal preferences and unrelated settings packets do not invalidate a theme preview", () => {
  const ctx = context();
  session.packets.settings(ctx, { prefs: structuredClone(ctx.state.prefs) });
  expect(ctx.invalidations).not.toContain("theme");
  ctx.invalidations.length = 0;
  session.packets.settings(ctx, { prefs: { ...ctx.state.prefs, autocomplete: false } });
  expect(ctx.invalidations).not.toContain("theme");
  session.packets.settings(ctx, { prefs: { ...ctx.state.prefs, theme: "light" } });
  expect(ctx.invalidations.filter((name) => name === "theme")).toHaveLength(1);
});

test("settings load revision refreshes theme stylesheet without resetting active preview", () => {
  const ctx = context();
  session.packets.settings(ctx, { prefs: { ...ctx.state.prefs, themeStylesVersion: 0 } });
  ctx.invalidations.length = 0;
  session.packets.settings(ctx, { prefs: { ...ctx.state.prefs, themeStylesVersion: 1 } });
  expect(ctx.invalidations).toContain("themeStyles");
  expect(ctx.invalidations).not.toContain("theme");
  ctx.invalidations.length = 0;
  session.packets.settings(ctx, { prefs: { ...ctx.state.prefs } });
  expect(ctx.invalidations).not.toContain("themeStyles");
});

test("initial settings reuse the loaded stylesheet; project switches and revisions refetch it", async () => {
  const originals = new Map(["matchMedia", "document", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "", userAgent: "" } });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  let href = "http://localhost/project/themes.css";
  let writes = 0;
  const link = { get href() { return href; }, set href(value) { href = new URL(value, "http://localhost/project/").href; writes++; } };
  globalThis.document = { baseURI: "http://localhost/project/", querySelector: () => link };
  try {
    const { refreshThemeStyles } = await import("../lib/app/web/public/app/theme-service.js");
    refreshThemeStyles(0, "/project/themes.css");
    expect(writes).toBe(0);
    refreshThemeStyles(0, "/other/themes.css");
    expect(href).toBe("http://localhost/other/themes.css?v=0");
    expect(writes).toBe(1);
    refreshThemeStyles(0, "/other/themes.css");
    expect(writes).toBe(1);
    refreshThemeStyles(1, "/other/themes.css");
    expect(href).toBe("http://localhost/other/themes.css?v=1");
    expect(writes).toBe(2);
  } finally {
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});

test("reapplying the same appearance performs no document or meta writes", async () => {
  const originals = new Map(["matchMedia", "document", "getComputedStyle", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let writes = 0;
  let dark = false;
  const dataset = new Proxy({ theme: "", mode: "light" }, { set: (target, key, value) => { writes++; target[key] = value; return true; } });
  const style = new Proxy({ colorScheme: "light" }, { set: (target, key, value) => { writes++; target[key] = value; return true; } });
  const meta = { value: "rgb(255, 255, 255)", getAttribute() { return this.value; }, setAttribute(_key, value) { writes++; this.value = value; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "", userAgent: "" } });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.document = { documentElement: { dataset, style, classList: { contains: () => dark, toggle: (_name, value) => { writes++; dark = value; } } }, body: {}, querySelector: () => meta };
  globalThis.getComputedStyle = () => ({ backgroundColor: dark ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)" });
  try {
    const { applyThemeName } = await import("../lib/app/web/public/app/theme-service.js");
    applyThemeName("light"); await Promise.resolve();
    expect(writes).toBe(0);
    applyThemeName("dark"); await Promise.resolve();
    expect(dark).toBe(true);
    expect(dataset.mode).toBe("dark");
    const changed = writes;
    applyThemeName("dark"); await Promise.resolve();
    expect(writes).toBe(changed);
    let rebuilds = 0;
    const body = { children: [], replaceChildren(...children) { rebuilds++; this.children = children; }, append(...children) { this.children.push(...children); } };
    globalThis.document.querySelector = () => body;
    globalThis.document.createElement = () => {
      const node = { className: "", children: [], dataset: {}, textContent: "", attributes: new Map(),
        append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }, addEventListener() {},
        remove() { this.parent.children = this.parent.children.filter((child) => child !== this); },
        getAttribute(key) { return this.attributes.get(key); }, setAttribute(key, value) { this.attributes.set(key, value); },
        querySelector(selector) { return this.children.find((child) => child.className === selector.slice(1)) ?? null; },
      };
      node.classList = { contains: (name) => node.className.split(" ").includes(name), toggle: (name, on) => { node.className = [...node.className.split(" ").filter((item) => item !== name && item), ...(on ? [name] : [])].join(" "); } };
      return node;
    };
    const { renderThemesBody } = await import("../lib/app/web/public/app/views/panels/theme.js");
    renderThemesBody();
    renderThemesBody();
    expect(rebuilds).toBe(1);
    const { state } = await import("../lib/app/web/public/app/state.js");
    const prefs = state.prefs;
    const cards = body.children.at(-1).children.slice();
    try {
      state.prefs = { ...prefs, theme: prefs.theme === "dark" ? "light" : "dark", activeTheme: null };
      renderThemesBody();
      expect(rebuilds).toBe(1);
      expect(body.children.at(-1).children).toEqual(cards);
      expect(cards.find((card) => card.classList.contains("current"))?.getAttribute("aria-pressed")).toBe("true");
    } finally { state.prefs = prefs; }
  } finally {
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
