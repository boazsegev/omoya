import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/gtui/gtui.js";

async function snapshot(node, size = {}) {
  const memory = GTUI.host.memory(size);
  const ui = new GTUI({ host: memory });
  const running = ui.run({ init: () => ({ model: null, effects: [] }), update: (model) => model, view: () => node });
  const result = memory.snapshot();
  ui.stop();
  await running;
  return result;
}

const text = (props, content) => GTUI.view.text({ margin: 0, ...props }, content);

describe("GTUI semantic layout", () => {
  test("defaults text to two-character side margins and permits explicit overrides", async () => {
    expect((await snapshot(GTUI.view.text({}, "edge"), { width: 12, height: 1 })).lines).toEqual(["  edge"]);
    expect((await snapshot(GTUI.view.text({ margin: 0 }, "edge"), { width: 12, height: 1 })).lines).toEqual(["edge"]);
  });

  test("centers tables as a whole inside the standard text margins", async () => {
    const table = GTUI.view.table({}, [{ role: "table.head", cells: [[{ text: "A" }], [{ text: "B" }]] }, { cells: [[{ text: "one" }], [{ text: "two" }]] }]);
    const result = await snapshot(table, { width: 20, height: 2 });
    expect(result.lines).toEqual(["     A     B", "     one   two"]);
  });

  test("lays out row, column, and fixed/auto/fill grid tracks", async () => {
    const node = GTUI.view.column({}, [
      GTUI.view.row({ columns: [3, "fill", "auto"] }, [
        text({ overflow: "clip-end" }, "abcd"),
        text({}, "middle"),
        text({}, "Z"),
      ]),
      GTUI.view.grid({ columns: ["fill", 4] }, [
        text({}, "left"), text({}, "one"),
        text({}, "next"), text({}, "two"),
      ]),
    ]);
    expect((await snapshot(node, { width: 12, height: 3 })).lines).toEqual(["ab…middle  Z", "left    one", "next    two"]);
  });

  test("drops the lowest-priority children first in tight tracks", async () => {
    const node = GTUI.view.column({}, [
      text({ priority: 5 }, "keep"),
      text({ priority: -1 }, "drop me"),
      text({ priority: 1 }, "also keep"),
    ]);
    expect((await snapshot(node, { width: 12, height: 2 })).lines).toEqual(["keep", "also keep"]);
  });

  test("wraps and clips rich spans while retaining roles, links, and source offsets", async () => {
    const node = GTUI.view.column({}, [
      text({}, [
        { content: "hello ", role: "greeting", source: { itemKey: "m1", start: 10 } },
        { content: "world", role: "link", link: "https://example.test", source: { itemKey: "m1", start: 16 } },
      ]),
      text({ overflow: "clip-start", role: "tail" }, "abcdefgh"),
    ]);
    const result = await snapshot(node, { width: 7, height: 3 });
    expect(result.lines).toEqual(["hello", "world", "…cdefgh"]);
    expect(result.roles).toContainEqual({ row: 1, start: 0, end: 5, role: "link" });
    expect(result.links).toEqual([{ row: 1, start: 0, end: 5, link: "https://example.test" }]);
    expect(result.sources).toContainEqual({ row: 1, start: 0, end: 1, source: { itemKey: "m1", start: 16, end: 17 } });
  });

  test("renders each wide glyph once and enforces text maxWidth", async () => {
    const node = GTUI.view.column({}, [
      text({}, "a🟠b"),
      text({ maxWidth: 5, overflow: "clip-start" }, "abcdefgh"),
    ]);
    expect((await snapshot(node, { width: 12, height: 2 })).lines).toEqual(["a🟠b", "…efgh"]);
  });

  test("renders bidi rows visually while retaining logical source offsets", async () => {
    const node = GTUI.view.column({}, [
      text({}, [{ content: "שלום", source: { itemKey: "he", start: 0 } }]),
      text({}, [{ content: "مَر", source: { itemKey: "ar", start: 0 } }]),
    ]);
    const result = await snapshot(node, { width: 10, height: 2 });
    expect(result.lines).toEqual(["םולש", "رمَ"]);
    expect(result.sources.filter(({ row }) => row === 0).map(({ source }) => source.start)).toEqual([3, 2, 1, 0]);
    expect(result.sources.filter(({ row }) => row === 1).map(({ source }) => source.start)).toEqual([2, 0]);
  });

  test("draws panel chrome without exposing geometry to the application", async () => {
    const node = GTUI.view.panel({ title: "Info" }, [text({ role: "body" }, "ok")]);
    const result = await snapshot(node, { width: 10, height: 3 });
    expect(result.lines).toEqual(["┌─ Info ─┐", "│ok      │", "└────────┘"]);
    expect(result.roles).toContainEqual({ row: 1, start: 1, end: 3, role: "body" });
  });

  test("end-anchored scroll reveals older rows without drawing outside its box", async () => {
    const content = GTUI.view.column({}, Array.from({ length: 8 }, (_, index) => text({}, `line ${index}`)));
    const latest = GTUI.view.scroll({ id: "history", anchor: "end", offset: 0 }, [content]);
    const older = GTUI.view.scroll({ id: "history", anchor: "end", offset: 2 }, [content]);
    expect((await snapshot(latest, { width: 10, height: 3 })).lines).toEqual(["line 5", "line 6", "line 7"]);
    expect((await snapshot(older, { width: 10, height: 3 })).lines).toEqual(["line 3", "line 4", "line 5"]);
  });
});
