import { expect, test } from "bun:test";
import { createCompletionSources } from "../lib/app/tui/completion-sources.js";

function environment(name, tools) {
  return { prompts: () => new Map([[name, {}]]), models: () => new Map(), tools,
    settings: { providers: {} } };
}

test("completion catalog follows the viewed Env and discards a late refresh from another project", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const a = environment("A", async () => { await gate; return new Map([["from-a", { name: "from-a" }]]); });
  const b = environment("B", async () => new Map([["from-b", { name: "from-b" }]]));
  let current = a;
  const agent = { can: { write: true } };
  const sources = createCompletionSources(agent, a, { getEnv: () => current });
  const first = sources.refresh();
  current = b;
  expect(sources.catalog().tools).toEqual([]);
  await sources.refresh();
  expect(sources().prompts).toEqual(["/B"]);
  expect(sources.catalog().tools.map(({ name }) => name)).toEqual(["from-b"]);
  release();
  await first;
  expect(sources().prompts).toEqual(["/B"]);
  expect(sources().shims).toEqual(["/tool-from-b"]);
});
