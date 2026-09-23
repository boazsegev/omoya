// test/api-docs.test.js — OWNS documentation generation. API.md and
// API-schema.md are checked-in generated artifacts, and generation is
// not optional: every `bun test` run rewrites both from the live tree
// (a stale working tree simply becomes visibly dirty in git). The
// generator libraries live beside this file (test/api-reference.js,
// test/api-schema.js) — the tests are the only source of truth; their
// --check gates live here as assertions: every public export
// documented, every contract source resolving.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { collect, contractProblems, renderApiReference } from "./api-reference.js";
import { generate } from "./api-schema.js";

describe("generated API documentation", () => {
  test("every public export is documented, every contract source resolves", async () => {
    const problems = contractProblems(await collect());
    expect(problems).toEqual([]);
  }, 20_000);

  test("API.md regenerates from the live tree on every run", async () => {
    const text = await renderApiReference();
    writeFileSync("API.md", text);
    expect(readFileSync("API.md", "utf8")).toBe(text);
    expect(text).toContain("# API (");
  }, 20_000);

  test("API-schema.md regenerates from the live tree on every run", async () => {
    const text = await generate();
    writeFileSync("API-schema.md", text);
    expect(readFileSync("API-schema.md", "utf8")).toBe(text);
    expect(text).toStartWith("# API schema");
  }, 20_000);
});
