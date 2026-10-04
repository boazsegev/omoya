// Shipped authoring skills: structural/discovery checks, not LLM behavior evals.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Env } from "../lib/env.js";
import { Agent } from "../lib/agent.js";
import { skill } from "../tools/skill.js";

const targets = ["ai-prompt-authoring", "ai-skill-authoring"];

// Only the simple scalar frontmatter deliberately used by these shipped files.
function metadata(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const field = line.match(/^([a-z-]+): (.+)$/);
    expect(field).not.toBeNull();
    return [field[1], field[2].replace(/^"(.*)"$/, "$1")];
  }));
}

// Isolate package contents from user/project instruction layers.
const env = new Env({ settings: {}, skillDirs: ["./skills"] });

describe("shipped authoring skills", () => {
  for (const name of targets) {
    test(`${name}: format and public catalog/load contract`, async () => {
      const path = `skills/${name}/SKILL.md`;
      const text = readFileSync(path, "utf8");
      const meta = metadata(text);
      expect(meta.name).toBe(name);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(meta.description.length).toBeGreaterThanOrEqual(25);
      expect(meta.description.length).toBeLessThanOrEqual(1023);
      // No hidden resources or authorship evidence in loaded instructions.
      expect(readdirSync(`skills/${name}`)).toEqual(["SKILL.md"]);
      expect(text).not.toMatch(/^## (?:Evidence basis|Research|References|Sources)\b/m);
      expect(text).not.toMatch(/https?:\/\//);
      // Authoring guidance stays independent of a particular harness/API.
      expect(text).not.toMatch(/\bOmoya\b|worker-(?:create|message|status|close)|tool-refresh|authorized-root/);
      expect(text).not.toMatch(/^## (?:Dispatch and follow up|Activate and verify)$/m);

      const entry = env.skills().get(name);
      expect(entry.name).toBe(name);
      expect(entry.description).toBe(meta.description);
      expect(entry.body).toBe(text.slice(text.indexOf("\n---\n") + 5).trim());
      expect(Agent.skillCatalog(env.skills())).toContain(`\`${name}\` — ${meta.description}`);
      const loaded = await skill({ names: [name] }, { env });
      expect(loaded.result).toBe(`Loaded skills: ${name}.`);
      expect(loaded.system).toEqual([Agent.skillSection(entry)]);
    });
  }

  test("live disk edits are discoverable but previously returned instructions remain unchanged", async () => {
    mkdirSync("./ai-tmp", { recursive: true });
    const root = mkdtempSync("./ai-tmp/live-authoring-");
    try {
      const live = new Env({ settings: {}, skillDirs: [root] });
      const name = "live-contract";
      expect(live.skills().has(name)).toBe(false);
      mkdirSync(join(root, name));
      const path = join(root, name, "SKILL.md");
      const front = `---\nname: ${name}\ndescription: Live test skill\n---\n`;
      writeFileSync(path, `${front}First checked body.\n`);
      const first = await skill({ names: [name] }, { env: live });
      expect(first.system[0]).toContain("First checked body.");
      writeFileSync(path, `${front}Second checked body.\n`);
      const second = await skill({ names: [name] }, { env: live });
      expect(second.system[0]).toContain("Second checked body.");
      expect(first.system[0]).toContain("First checked body.");
      expect(first.system[0]).not.toContain("Second checked body.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
