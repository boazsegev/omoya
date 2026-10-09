import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { NAMES } from "../lib/namespace.js";
import { Context } from "../lib/context.js";

const resumeModule = new URL("../lib/app/cli/resume.js", import.meta.url).href;
const envModule = new URL("../lib/env.js", import.meta.url).href;
const child = `
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Env } from ${JSON.stringify(envModule)};
import { adoptResumeOrigin } from ${JSON.stringify(resumeModule)};
const { EXPECTED_DIR, EXPECTED_ORIGIN, CASE } = process.env;
const original = process.cwd();
let open;
try {
  if (CASE === "open") {
    open = await Env.open(original);
    assert.equal(open.settings.sessions, EXPECTED_DIR);
  } else if (CASE !== "explicit" && CASE !== "missing" && CASE !== "vanished") {
    const early = await Env.open(original);
    try {
      assert.equal(early.settings.sessions, EXPECTED_DIR);
    } finally { await early.close(); }
  }
  if (CASE === "missing" || CASE === "vanished") {
    await assert.rejects(adoptResumeOrigin({ resume: CASE, dir: EXPECTED_DIR }),
      CASE === "missing" ? /no such session/ : /folder no longer exists/);
    assert.equal(process.cwd(), original);
  } else {
    for (const options of [{ resume: "latest" }, { resume: "true" }, { resume: "id", anonymous: true }, {}]) {
      assert.equal(await adoptResumeOrigin(options), null);
      assert.equal(process.cwd(), original);
    }
    const adopted = await adoptResumeOrigin({ resume: "id", ...(CASE === "explicit" ? { dir: EXPECTED_DIR } : {}) });
    assert.equal(resolve(adopted), EXPECTED_ORIGIN);
    assert.equal(process.cwd(), EXPECTED_ORIGIN);
  }
} finally {
  process.chdir(original);
  await open?.close();
  assert.equal(Env.envs[original], undefined);
}
`;

describe("CLI resume origin", () => {
  test("awaits file-backed project/user sessions before moving cwd and releases lookup Env", async () => {
    const root = resolve(mkdtempSync("./ai-tmp/cli-resume-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const origin = join(root, "origin");
    const vanished = join(root, "vanished");
    try {
      for (const path of [project, home, origin, vanished]) mkdirSync(path);
      const configured = {
        project: join(project, "project-logs"),
        user: join(home, "user-logs"),
      };
      for (const [name, dir] of Object.entries(configured)) {
        const context = new Context({ id: "id", dir, origin });
        context.append({ type: 2, content: [{ type: "text", text: "saved" }] });
        await context.close();
      }
      const ghost = new Context({ id: "vanished", dir: configured.project, origin: vanished });
      ghost.append({ type: 2, content: [{ type: "text", text: "saved" }] });
      await ghost.close();
      rmSync(vanished, { recursive: true });
      const run = (kind, expectedDir, config = {}) => {
        writeFileSync(join(home, "settings.json"), JSON.stringify({ sessions: "user-logs" }));
        writeFileSync(join(project, NAMES.projectSettings), JSON.stringify(config));
        const result = spawnSync(process.execPath, ["--eval", child], {
          cwd: project,
          env: { ...process.env, [NAMES.settingsEnv]: home, CASE: kind, EXPECTED_DIR: expectedDir, EXPECTED_ORIGIN: origin },
          encoding: "utf8", timeout: 10000,
        });
        expect(result.error).toBeUndefined();
        expect({ kind, status: result.status, stderr: result.stderr }).toEqual({ kind, status: 0, stderr: "" });
        expect(result.stderr).toBe("");
      };
      run("project", configured.project, { sessions: "project-logs" });
      run("open", configured.project, { sessions: "project-logs" });
      run("user", configured.user);
      run("explicit", configured.project);
      run("missing", configured.project);
      run("vanished", configured.project);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
