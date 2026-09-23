import { describe, expect, test } from "bun:test";
import { createInlineRenderer } from "../lib/gtui/inline-render.js";

describe("gtui inline renderer", () => {
  test("commits finalized rows once and repaints only the transient region", () => {
    const render = createInlineRenderer({ rows: () => 8, sync: false });
    const first = render.paint({ commit: ["one", ""], region: ["draft", "> "], cursor: { row: 2, col: 3 } });
    const second = render.paint({ commit: [], region: ["draft more", "> "], cursor: { row: 2, col: 3 } });
    expect(first).toContain("one\n\n");
    expect(second).not.toContain("one");
    expect(second).toContain("\x1b[1A\r\x1b[Jdraft more\n> ");
    expect(`${first}${second}`).not.toContain("\x1b[[H");
  });

  test("refresh clears and permits the complete transcript to be committed again", () => {
    const render = createInlineRenderer({ rows: () => 8, sync: false });
    render.paint({ commit: ["old"], region: ["> "] });
    const bytes = render.refresh({ commit: ["old", "new"], region: ["> "] });
    expect(bytes).toStartWith("\x1b[3J\x1b[2J\x1b[H");
    expect(bytes).toContain("old\nnew\n");
  });

  test("caps only the repaintable region and lets committed history overflow", () => {
    const render = createInlineRenderer({ rows: () => 2, sync: false });
    const bytes = render.paint({ commit: ["history 1", "history 2", "history 3"], region: ["hidden", "live 1", "live 2"] });
    expect(bytes).toContain("history 1\nhistory 2\nhistory 3\n");
    expect(bytes).not.toContain("hidden");
    expect(bytes).toContain("live 1\nlive 2");
  });

  test("never emits alternate-screen control sequences", () => {
    const render = createInlineRenderer({ rows: () => 8, sync: false });
    const bytes = render.paint({ commit: ["row"], region: ["> "] }) + render.leave();
    expect(bytes).not.toContain("\x1b[?1049h");
    expect(bytes).not.toContain("\x1b[?1049l");
  });
});
