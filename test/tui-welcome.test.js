import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { createApp } from "../lib/app/tui/app.js";
import { welcomeArt, welcomeView } from "../lib/app/tui/welcome-view.js";
import { layoutView, sceneText } from "../lib/app/gtui/layout.js";
import { createControls } from "../lib/app/gtui/controls.js";
import { createInlineTerminalRenderer } from "../lib/app/gtui/terminal-inline-host.js";
import { createTheme } from "../lib/app/gtui/theme.js";
import { TerminalScreen } from "./terminal-screen.js";
import { testEnv, USER } from "./fakes.js";

const theme = createTheme();
const textOf = (node) => JSON.stringify(node);

function screen(root, width, height) {
  return sceneText(layoutView(root, { width, height, controls: createControls(), theme })).split("\n");
}

describe("TUI opening", () => {
  test("a symmetric circular O replaces the first letter; its colors invert the old mark", () => {
    for (const wide of [true, false]) {
      const art = welcomeArt(wide, 100);
      const lines = art.map((row) => row.content.map((span) => span.text).join(""));
      const ring = art.map((row) => row.content.filter((span) => span.role === "accent").map((span) => span.text).join(""));
      expect(art).toHaveLength(13);
      expect(ring[0]).toBe(ring[12]);
      expect(ring[1]).toBe(ring[11]);
      expect(lines.at(-1).slice(34)).toContain("█");
      expect(art.flatMap((row) => row.content).some((span) => span.role === "accent" && span.text === "█")).toBe(true);
      expect(art.flatMap((row) => row.content).some((span) => span.role === "welcome.foreground" && span.text === "█")).toBe(true);
      const chevron = art[4].content.slice(1).findIndex((span) => span.role === "welcome.foreground");
      expect(chevron).toBe(10); // centered one cell farther right than the former x=9
      expect(art[8].content.filter((span) => span.role === "welcome.foreground").length).toBe(7); // two-pixel chevron, four-pixel cursor, MOYA
      expect(new Set(lines.map((line) => line.indexOf("█"))).size).toBeGreaterThan(1);
    }
  });

  test("offers live prompt names before command hints, with a compact narrow fallback", () => {
    const wide = textOf(welcomeView({ model: "p/m", session: "test", prompts: ["task", "commit"] }));
    expect(wide.indexOf("/task   /commit")).toBeLessThan(wide.indexOf("/ commands"));
    expect(textOf(welcomeView({ width: 40 }))).toContain("Omoya");
    const opening = welcomeView({ width: 100, model: "p/m", topSpace: 2, prompts: ["task"] }).children;
    expect(opening[0].content.map((span) => span.text).join("").trim()).toBe("");
    expect(opening[1].content.map((span) => span.text).join("").trim()).toBe("");
    expect(opening.some((row) => JSON.stringify(row).includes("Session:"))).toBe(false);
    expect(opening.find((row) => JSON.stringify(row).includes("Talking to p/m")).role).toBe("welcome.foreground");
    const lead = opening.find((row) => JSON.stringify(row).includes("Talking to p/m"));
    const leadText = lead.content.map((span) => span.text).join("");
    expect(leadText.indexOf("Talking")).toBeGreaterThan(20);
    expect(opening.filter((row) => row.content.map((span) => span.text).join("").trim() === "").length).toBeGreaterThan(3);
  });

  test("sits after leading system messages and keeps input at bottom in both hosts", async () => {
    const env = await testEnv();
    const agent = new Agent({ env, model: "p/m", context: [] });
    const model = createApp(agent, { env }).init().model;
    for (const [width, height] of [[100, 32], [40, 12]]) {
      const app = createApp(agent, { env, columns: width, rows: height, sources: { catalog: () => ({ prompts: ["task"] }) } });
      const root = app.view(model);
      const lines = screen(root, width, height);
      const mark = lines.findIndex((line) => line.includes(width === 40 ? "Omoya" : "████"));
      const composer = lines.findIndex((line) => line.includes("Ask anything"));
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(composer).toBeGreaterThan(mark);
      expect(composer).toBeGreaterThanOrEqual(height - 8);
      const output = new TerminalScreen(width, height);
      const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => height });
      renderer.render(root, theme, { width, height });
      expect(output.text()).toContain("idle");
      expect(output.text().split("\n").findIndex((line) => line.includes("idle"))).toBeGreaterThanOrEqual(height - 8);
    }
    agent.context.append(USER("hello"));
    const app = createApp(agent, { env, columns: 100, rows: 32 });
    const feed = app.view(model).children[0].children[0].items;
    const index = feed.findIndex((item) => item.key === "startup-banner");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(feed[index + 1].key).toContain("user");
    const resumed = screen(app.view(model), 100, 32).join("\n");
    expect(resumed).toContain("Talking to p/m");
    expect(resumed).toContain("hello");
  });
});
