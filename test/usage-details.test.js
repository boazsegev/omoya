import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { usageDetailLines } from "../lib/app/shared/format.js";
import { initialModel } from "../lib/app/tui/app-events.js";
import { statusView } from "../lib/app/tui/status-view.js";
import { view } from "../lib/app/gtui/gtui.js";
import { layoutView } from "../lib/app/gtui/layout.js";

const usage = { context: { used: 250, total: 1000, approximate: false }, input: 120, output: 30, cost: 0.05 };
const plan = { label: "Pro", quotas: { credits: { remaining: 12, unit: "usd" }, session: { used: 3, total: 10 }, weekly: { used: 5, total: 20 }, daily: { used: 1, total: 5 } } };

test("expanded usage lists context, session, cost, and every known quota including credits", () => {
  const lines = usageDetailLines(usage, plan).join("\n");
  expect(lines).toContain("Context: 250/1,000 tokens (25.0%)");
  expect(lines).toContain("Session: 120 in · 30 out");
  expect(lines).toContain("Cost: $0.05");
  for (const name of Object.keys(plan.quotas)) expect(lines).toContain(name);
  expect(lines).toContain("$12.00 left");
});

test("zero cost is hidden and small nonzero costs never round to zero", () => {
  for (const cost of [undefined, 0, NaN]) expect(usageDetailLines({ cost }).join("\n")).not.toContain("Cost:");
  expect(usageDetailLines({ cost: 0.000001 }).join("\n")).toContain("Cost: $0.000001");
});

test("full details display nested provider fields and unknown quota fields with readable labels", () => {
  const lines = usageDetailLines({ ...usage, input_tokens_details: { cached_tokens: 10, reasoning_tokens: 2 }, service_tier: "standard", token_types: [{ token_count: 4 }], provider_flag: false }, {
    label: "Pro", renewal_note: "tomorrow", quotas: { rolling_window: { used: 3, unit: "tokens", windowSeconds: 3600, custom_limit: 100, custom_details: { bonus_tokens: 5 } } },
  }).join("\n");
  expect(lines).toContain("input tokens details · cached tokens: 10");
  expect(lines).toContain("input tokens details · reasoning tokens: 2");
  expect(lines).toContain("service tier: standard");
  expect(lines).toContain("token types · 1 · token count: 4");
  expect(lines).toContain("provider flag: false");
  expect(lines).toContain("rolling window");
  expect(lines).toContain("rolling window (1h window):");
  expect(lines).not.toContain("window seconds: 3,600");
  expect(lines).toContain("custom limit: 100");
  expect(lines).toContain("custom details · bonus tokens: 5");
  expect(lines).toContain("renewal note: tomorrow");
  expect(lines).not.toContain("[object Object]");
});

test("TUI and Web snapshots retain provider usage details", async () => {
  const { statusData } = await import("../lib/app/tui/status-data.js");
  const { AgentSession } = await import("../lib/app/web/session.js");
  const providerUsage = { inputTokens: 10, outputTokens: 5, cost: 0.01, input_tokens_details: { cached_tokens: 4 } };
  const agent = { can: { write: true }, usage: providerUsage, contextUsage: { used: 10, total: 100 }, context: { planUsage: null, messages: () => [] }, env: {}, onEvent: () => 1, offEvent: () => {} };
  expect(statusData({ agent }).usage.input_tokens_details).toEqual({ cached_tokens: 4 });
  const session = new AgentSession(agent);
  expect(session.statusSnapshot().input_tokens_details).toEqual({ cached_tokens: 4 });
  session.dispose();
});

test("Web meter stays context-only while its popover retains every provider quota and detail", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousMatchMedia = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  const element = () => ({ children: [], style: { setProperty() {} }, classList: { toggle() {} }, replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, setAttribute() {} });
  const meter = element();
  const details = element();
  globalThis.document = { querySelector: (selector) => selector === "#usage-status" ? meter : selector === "#usage-details" ? details : null, createElement: element };
  globalThis.matchMedia = () => ({ matches: false });
  let state;
  let previousUsage;
  let previousExpanded;
  try {
    ({ state } = await import("../lib/app/web/public/app/state.js"));
    previousUsage = state.usage;
    previousExpanded = state.usageExpanded;
    const { updateUsage, installKeys, mount } = await import("../lib/app/web/public/app/views/shell/shell.js");
    const quotaReports = [
      null,
      // API rate limits (OpenAI, Anthropic and other providers).
      { quotas: { requests: { total: 1000, remaining: 1000 }, tokens: { total: 100000, remaining: 99000 } } },
      // Subscription allowance windows (Anthropic, OpenAI and Kimi).
      { quotas: { "5h": { total: 100, used: 12, unit: "percent" }, "7d": { total: 100, used: 35, unit: "percent" } } },
      { label: "Custom plan", quotas: { custom_allowance: { total: 50, used: 5 }, credits: { remaining: 12, unit: "usd" } }, details: { provider_flag: false } },
    ];
    for (const plan of quotaReports) {
      state.usage = { used: 36000, available: 1100000, input: 10, output: 5, plan };
      const report = JSON.stringify(state.usage);
      state.usageExpanded = false;
      updateUsage();
      expect(meter.children.map((node) => node.textContent ?? "").join("")).toBe("36k/1.1M");
      expect(details.hidden).toBe(true);
      expect(details.children).toHaveLength(0);
      state.usageExpanded = true;
      updateUsage();
      expect(meter.children.map((node) => node.textContent ?? "").join("")).toBe("36k/1.1M");
      expect(details.hidden).toBe(false);
      const lines = details.children.map((node) => node.textContent);
      expect(lines).toEqual(usageDetailLines({ input: 10, output: 5, context: { used: 36000, total: 1100000 } }, plan));
      expect(JSON.stringify(state.usage)).toBe(report);
    }
    state.usageExpanded = true;
    state.usage = { used: 10, available: 100, input: 10, output: 5, cost: 0, input_tokens_details: { cached_tokens: 4 }, service_tier: "<script>not markup</script>", plan: null };
    updateUsage();
    expect(details.hidden).toBe(false);
    const lines = details.children.map((node) => node.textContent).join("\n");
    expect(lines).toContain("input tokens details · cached tokens: 4");
    expect(lines).toContain("service tier: <script>not markup</script>");
    expect(lines).not.toContain("Cost:");
    expect(lines).not.toContain("available:");
    const firstChild = details.children[0];
    updateUsage();
    expect(details.children[0]).toBe(firstChild);
    state.usageExpanded = false;
    updateUsage();
    expect(details.children).toHaveLength(0);
    state.usageExpanded = true;
    state.usage.cost = 0.000001;
    updateUsage();
    expect(details.children.map((node) => node.textContent).join("\n")).toContain("Cost: $0.000001");
    const listeners = new Map();
    const events = [];
    document.addEventListener = (type, callback) => listeners.set(type, callback);
    mount(null, { emit: (...args) => events.push(args) });
    installKeys();
    const inside = { closest: (selector) => ["#usage-details", ".usage-anchor"].includes(selector) ? details : null };
    listeners.get("pointerdown")({ target: inside });
    listeners.get("wheel")({ target: inside });
    listeners.get("keydown")({ target: inside, key: "ArrowDown" });
    expect(events).toEqual([]);
    let focused = false;
    meter.focus = () => { focused = true; };
    listeners.get("keydown")({ target: inside, key: "Escape", preventDefault() {} });
    expect(events).toEqual([["usage.dismiss"]]);
    expect(focused).toBe(true);
    listeners.get("pointerdown")({ target: { closest: () => null } });
    expect(events.at(-1)).toEqual(["usage.dismiss"]);
    mount(null, { emit() {} });
  } finally {
    if (state) { state.usage = previousUsage; state.usageExpanded = previousExpanded; }
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousMatchMedia) Object.defineProperty(globalThis, "matchMedia", previousMatchMedia); else delete globalThis.matchMedia;
  }
});

test("TUI usage readout stays fixed; details belong to a floating view", () => {
  const model = initialModel();
  expect(model.usageExpanded).toBe(false);
  const data = { identity: { cwd: "" }, chips: [], state: "idle", hints: "", turnReadout: { before: "250/1000", after: "25%" }, contextPercent: 25, usage, plan };
  const collapsed = statusView(data);
  expect(JSON.stringify(collapsed)).toContain("status.usage");
  expect(JSON.stringify(collapsed)).not.toContain("Session: 120 in");
  expect(JSON.stringify(statusView(data, { usageExpanded: true }))).not.toContain("Session: 120 in");
  const { usagePopover } = require("../lib/app/tui/status-view.js");
  expect(JSON.stringify(usagePopover(data))).toContain("Session: 120 in");
});

test("TUI popover paints above the readout without moving input, readout, or transcript", () => {
  const data = { identity: { cwd: "" }, chips: [], state: "idle", hints: "", turnReadout: { before: "250/1000", after: "25%" }, contextPercent: 25, usage, plan };
  const base = view.column({ viewportFill: true, rows: ["fill", "auto", "auto"] }, [view.text({}, "Transcript"), view.text({}, "Input"), statusView(data)]);
  const floating = view.overlay({ passive: true, position: "above-right", anchorAction: "status.usage" }, [base, require("../lib/app/tui/status-view.js").usagePopover(data)]);
  const plain = layoutView(base, { width: 80, height: 20 }).snapshot.lines;
  const popped = layoutView(floating, { width: 80, height: 20 }).snapshot.lines;
  for (const text of ["Transcript", "Input", "250/1000"]) expect(popped.findIndex((line) => line.includes(text))).toBe(plain.findIndex((line) => line.includes(text)));
  expect(popped.join("\n")).toContain("Session: 120 in");
  expect(popped.findIndex((line) => line.includes("Session: 120 in"))).toBeLessThan(popped.findIndex((line) => line.includes("250/1000")));
  const inline = layoutView(floating, { width: 80, height: 20, verticalAlign: "end" }).snapshot.lines;
  expect(inline.findIndex((line) => line.includes("250/1000"))).toBe(layoutView(base, { width: 80, height: 20, verticalAlign: "end" }).snapshot.lines.findIndex((line) => line.includes("250/1000")));
});

test("web usage meter is separate from the block viewer control", () => {
  const composer = readFileSync(new URL("../lib/app/web/public/app/views/composer/composer.js", import.meta.url), "utf8");
  expect(composer).toContain('emit("usage.toggle")');
  expect(composer).toContain('emit("viewer.open")');
  expect(composer).toContain('id = "usage-details"');
  const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.composer\s*\{[^}]*position:\s*relative/);
  expect(css).toMatch(/\.usage-anchor[^{}]*\{[^}]*position:\s*relative/);
  expect(css).toMatch(/\.usage-details\s*\{[^}]*position:\s*absolute/);
  expect(css).toMatch(/\.usage-details\s*\{[^}]*bottom:\s*calc\(100%/);
  const mobile = css.slice(css.indexOf("@media (max-width: 40rem)"));
  expect(mobile).toMatch(/\.usage-anchor[^{}]*\{[^}]*position:\s*static/);
  expect(mobile).toMatch(/\.usage-details\s*\{[^}]*right:\s*\.55rem;[^}]*max-width:\s*calc\(100% - 1\.1rem\)/);
  const shell = readFileSync(new URL("../lib/app/web/public/app/views/shell/shell.js", import.meta.url), "utf8");
  expect(shell).toContain('document.addEventListener("pointerdown"');
  expect(shell).toContain('document.addEventListener("keydown"');
});
