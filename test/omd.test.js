import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { NAMES } from "../lib/namespace.js";
import { createEnvironment } from "../bin/scripts/daemon-env.js";

const root = resolve("ai-tmp");
const script = resolve("bin", `${NAMES.cliPrefix}d`);
const source = readFileSync(resolve("bin/scripts/daemon.js"), "utf8");
const childSource = readFileSync(resolve("bin/scripts/daemon-web.js"), "utf8");
const projectsSource = readFileSync(resolve("bin/scripts/daemon-projects.js"), "utf8");
const envSource = readFileSync(resolve("bin/scripts/daemon-env.js"), "utf8");
/** A fast, deterministic login shell: a script answering `env -0` with a fixed dump. */
const fakeShell = (folder, extra = "") => {
  const shell = join(folder, "fake-shell");
  writeFileSync(shell, `#!${["", "usr", "bin", "env"].join("/")} bun\nprocess.stdout.write(${JSON.stringify(`PATH=/usr/bin:/bin\0${extra}`)});\n`, { mode: 0o755 });
  return shell;
};
/** A fake spawnImpl answering each dump in order (the last one repeats). */
const fakeSpawn = (dumps) => {
  let calls = 0;
  return () => {
    const text = dumps[Math.min(calls++, dumps.length - 1)];
    return {
      stdout: { on: (type, callback) => { if (type === "data") queueMicrotask(() => callback(text)); } },
      once: (event, callback) => { if (event === "close") queueMicrotask(() => callback(0)); },
      kill: () => {},
    };
  };
};
const run = (args) => new Promise((done) => {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (data) => { out += data; });
  child.stderr.on("data", (data) => { err += data; });
  child.on("close", (code) => done({ code, out, err }));
});

test("omd help and invalid arguments have no application startup side effects", async () => {
  const help = await run(["--help"]);
  expect(help.code).toBe(0);
  expect(help.out.length).toBeGreaterThan(0);
  expect(source).toContain("const INTERVAL = 300_000;");
  expect(source).not.toMatch(/\bomd\b|omd-/);
  expect(childSource).not.toMatch(/\bomd\b|omd-/);
  expect(projectsSource).not.toMatch(/\bomd\b|omd-/);
  expect(envSource).not.toMatch(/\bomd\b|omd-/);
  expect(readFileSync(resolve("bin/scripts/daemon-jobs.js"), "utf8")).not.toMatch(/\bomd\b|omd-/);
  expect((await run(["--port", "0"])).code).toBe(1);
});

test("daemon diagnostics include name, PID and machine-local minute without a timezone", async () => {
  const zone = "Pacific/Honolulu";
  const before = Date.now();
  const child = spawn(process.execPath, [script, "--port", "0"], {
    env: { ...process.env, TZ: zone }, stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (data) => { err += data; });
  const code = await new Promise((done) => child.once("close", done));
  const after = Date.now();
  expect(code).toBe(1);
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "2-digit", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  const stamp = (ms) => { const { year, month, day, hour, minute } = parts(ms); return `${year}-${month}-${day} ${hour}:${minute}`; };
  const match = err.trim().match(/^\(([^():]+):(\d+)\) (\d{2}-\d{2}-\d{2} \d{2}:\d{2}) (.+)$/);
  expect(match).not.toBeNull();
  expect(match[1]).toBe(`${NAMES.cliPrefix}d`);
  expect(Number(match[2])).toBe(child.pid);
  expect([stamp(before), stamp(after)]).toContain(match[3]);
  expect(match[4].length).toBeGreaterThan(0);
});

test("supervisor source imports only Node builtins and job checks live in a separate process", () => {
  expect([...source.matchAll(/^import .* from "([^"]+)";/gm)].map((match) => match[1]).every((name) => name.startsWith("node:") || name === "./daemon-env.js")).toBe(true);
  expect([...envSource.matchAll(/^import .* from "([^"]+)";/gm)].map((match) => match[1]).every((name) => name.startsWith("node:"))).toBe(true);
  expect(source).toContain('createEnvironment');
  expect(source).not.toContain("../../lib/");
  expect(source).not.toContain("OMOYA_SETTINGS_DIR");
  expect(source).not.toContain("projects.json");
  expect(source).toContain("launch(process.execPath, [PROJECTS");
  expect(source).toContain("launch(process.execPath, [JOBS");
  expect(source).toContain("jobsRoots: []");
  expect(projectsSource).toContain("env.constructor.settings.projects");
  expect(childSource.indexOf("process.chdir(project)")).toBeLessThan(childSource.indexOf("await import(app)"));
});

test("omd's fresh scan requires one project folder", async () => {
  const result = await run(["--help"]);
  expect(result.code).toBe(0);
  const child = spawn(process.execPath, [resolve("bin/scripts/daemon-jobs.js")], { stdio: ["ignore", "pipe", "pipe"] });
  expect(await new Promise((done) => child.once("close", done))).toBe(1);
});

test("omd forks eligible pinned projects in parallel and excludes an unpinned launch folder", async () => {
  const folder = mkdtempSync(join(root, "omd-parallel-"));
  const bin = join(folder, "bin");
  const settings = join(folder, "settings");
  const first = join(folder, "first"), second = join(folder, "second"), noJobs = join(folder, "no-jobs");
  mkdirSync(join(bin, "scripts"), { recursive: true });
  mkdirSync(settings);
  for (const project of [first, second, noJobs]) mkdirSync(project);
  for (const project of [first, second, folder]) mkdirSync(join(project, "ai-jobs"));
  copyFileSync(resolve("bin/scripts/daemon.js"), join(bin, "scripts/daemon.js"));
  copyFileSync(resolve("bin/scripts/daemon-env.js"), join(bin, "scripts/daemon-env.js"));
  copyFileSync(resolve("bin/scripts/daemon-web.js"), join(bin, "scripts/daemon-web.js"));
  writeFileSync(join(bin, "scripts/daemon-projects.js"), `import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const pins = Object.keys(JSON.parse(readFileSync(join(process.env.OMOYA_SETTINGS_DIR, "projects.json"), "utf8")).projects).sort();
console.log(JSON.stringify({ webRoot: pins[0] ?? process.cwd(), jobsRoots: (pins.length ? pins : [process.cwd()]).filter((path) => { try { return statSync(join(path, "ai-jobs")).isDirectory(); } catch { return false; } }) }));
`);
  writeFileSync(join(bin, NAMES.cliPrefix), "setInterval(() => {}, 10000);\n");
  writeFileSync(join(bin, "scripts/daemon-jobs.js"), `import { appendFileSync } from "node:fs";
appendFileSync(process.env.OMD_TEST_LOG, "start " + process.argv[2] + " " + process.cwd() + "\\n");
await new Promise((done) => setTimeout(done, 800));
appendFileSync(process.env.OMD_TEST_LOG, "end " + process.argv[2] + "\\n");
`);
  writeFileSync(join(settings, "projects.json"), JSON.stringify({ projects: { [first]: {}, [second]: {}, [noJobs]: {} } }));
  const log = join(folder, "checks.log");
  writeFileSync(join(bin, `${NAMES.cliPrefix}d`), `import "./scripts/daemon.js";\n`);
  const child = spawn(process.execPath, [join(bin, `${NAMES.cliPrefix}d`)], {
    cwd: folder, env: { ...process.env, SHELL: fakeShell(folder), OMOYA_SETTINGS_DIR: settings, OMD_TEST_LOG: log }, stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 6000);
  try {
    const deadline = Date.now() + 4500;
    let lines = [];
    while (Date.now() < deadline) {
      lines = (await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n") : [];
      if (lines.length >= 4) break;
      await Bun.sleep(30);
    }
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 2).sort()).toEqual([`start ${first} ${first}`, `start ${second} ${second}`]);
    expect(lines.slice(2).sort()).toEqual([`end ${first}`, `end ${second}`]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => child.once("close", done));
    clearTimeout(timeout);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("omd uses the alphabetically first available pin, not the launch folder", async () => {
  const folder = mkdtempSync(join(root, "omd-order-"));
  const bin = join(folder, "bin"), settings = join(folder, "settings");
  const first = join(folder, "z-first"), other = join(folder, "a-second");
  mkdirSync(join(bin, "scripts"), { recursive: true });
  for (const path of [settings, first, other]) mkdirSync(path);
  copyFileSync(resolve("bin/scripts/daemon.js"), join(bin, "scripts/daemon.js"));
  copyFileSync(resolve("bin/scripts/daemon-env.js"), join(bin, "scripts/daemon-env.js"));
  copyFileSync(resolve("bin/scripts/daemon-web.js"), join(bin, "scripts/daemon-web.js"));
  writeFileSync(join(bin, "scripts/daemon-projects.js"), `import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const pins = Object.keys(JSON.parse(readFileSync(join(process.env.OMOYA_SETTINGS_DIR, "projects.json"), "utf8")).projects).sort();
console.log(JSON.stringify({ webRoot: pins[0] ?? process.cwd(), jobsRoots: (pins.length ? pins : [process.cwd()]).filter((path) => { try { return statSync(join(path, "ai-jobs")).isDirectory(); } catch { return false; } }) }));
`);
  const log = join(folder, "web.log");
  writeFileSync(join(bin, NAMES.cliPrefix), `#!${["", "usr", "bin", "env"].join("/")} bun\nimport { appendFileSync } from "node:fs"; appendFileSync(process.env.OMD_TEST_LOG, JSON.stringify({ cwd: process.cwd(), settings: process.env.OMOYA_SETTINGS_DIR })); setInterval(() => {}, 10000);\n`, { mode: 0o755 });
  writeFileSync(join(bin, "scripts/daemon-jobs.js"), "process.exit(0);\n");
  writeFileSync(join(settings, "projects.json"), JSON.stringify({ projects: { [first]: {}, [other]: {} } }));
  writeFileSync(join(bin, `${NAMES.cliPrefix}d`), `import "./scripts/daemon.js";\n`);
  const child = spawn(process.execPath, [join(bin, `${NAMES.cliPrefix}d`)], {
    cwd: folder, env: { ...process.env, SHELL: fakeShell(folder), OMOYA_SETTINGS_DIR: settings, OMD_TEST_LOG: log }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((done) => child.once("close", done));
  try {
    const deadline = Date.now() + 3000;
    while (!(await Bun.file(log).exists()) && Date.now() < deadline) await Bun.sleep(30);
    expect(JSON.parse(await Bun.file(log).text())).toEqual({ cwd: other, settings });
  } finally {
    child.kill("SIGTERM");
    await closed;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("omd restarts a cleanly exiting Web child and only stops on its own signal", async () => {
  const folder = mkdtempSync(join(root, "omd-restart-"));
  const bin = join(folder, "bin"), settings = join(folder, "settings");
  mkdirSync(join(bin, "scripts"), { recursive: true });
  mkdirSync(settings);
  copyFileSync(resolve("bin/scripts/daemon.js"), join(bin, "scripts/daemon.js"));
  copyFileSync(resolve("bin/scripts/daemon-env.js"), join(bin, "scripts/daemon-env.js"));
  copyFileSync(resolve("bin/scripts/daemon-web.js"), join(bin, "scripts/daemon-web.js"));
  writeFileSync(join(bin, "scripts/daemon-projects.js"), `import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const pins = Object.keys(JSON.parse(readFileSync(join(process.env.OMOYA_SETTINGS_DIR, "projects.json"), "utf8")).projects).sort();
console.log(JSON.stringify({ webRoot: pins[0] ?? process.cwd(), jobsRoots: (pins.length ? pins : [process.cwd()]).filter((path) => { try { return statSync(join(path, "ai-jobs")).isDirectory(); } catch { return false; } }) }));
`);
  const log = join(folder, "web.log");
  writeFileSync(join(bin, NAMES.cliPrefix), `#!${["", "usr", "bin", "env"].join("/")} bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.OMD_TEST_LOG, process.pid + "\\n");
`, { mode: 0o755 });
  writeFileSync(join(bin, "scripts/daemon-jobs.js"), "process.exit(0);\n");
  writeFileSync(join(bin, `${NAMES.cliPrefix}d`), `import "./scripts/daemon.js";\n`);
  const child = spawn(process.execPath, [join(bin, `${NAMES.cliPrefix}d`)], {
    cwd: folder, env: { ...process.env, SHELL: fakeShell(folder), OMOYA_SETTINGS_DIR: settings, OMD_TEST_LOG: log }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((done) => child.once("close", done));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const deadline = Date.now() + 3500;
    let pids = [];
    while (Date.now() < deadline) {
      pids = (await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n") : [];
      if (pids.length >= 2) break;
      await Bun.sleep(40);
    }
    expect(pids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pids).size).toBeGreaterThanOrEqual(2);
    expect(child.exitCode).toBe(null);
  } finally {
    child.kill("SIGTERM");
    const code = await closed;
    expect(code).toBe(0);
    clearTimeout(timeout);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("omd starts Web with isolated settings and stops it on SIGTERM", async () => {
  const folder = mkdtempSync(join(root, "omd-"));
  const project = join(folder, "project");
  const settings = join(folder, "settings");
  mkdirSync(project);
  mkdirSync(settings);
  writeFileSync(join(settings, "projects.json"), JSON.stringify({ projects: { [project]: {} } }));
  const child = spawn(process.execPath, [script, "--port", "19879"], {
    cwd: root, env: { ...process.env, SHELL: fakeShell(folder), OMOYA_SETTINGS_DIR: settings }, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((done) => child.once("close", done));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 7000);
  try {
    let response;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !response?.ok) {
      try { response = await fetch("http://127.0.0.1:19879/"); } catch { /* server still starting */ }
      if (!response?.ok) await Bun.sleep(30);
    }
    expect(response?.ok).toBe(true);
    child.kill("SIGTERM");
    expect(await closed).toBe(0);
    expect((await Bun.file(join(settings, "projects.json")).json()).projects).toEqual({ [project]: {} });
  } finally {
    child.kill("SIGTERM");
    await closed;
    clearTimeout(timeout);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("child environment: fresh login values overlay, retired profile keys are removed, inline values survive", async () => {
  const spawnImpl = fakeSpawn([
    "PATH=bin\0HOME=home/u\0RETIRED_KEY=old\0PWD=elsewhere\0SHLVL=1\0",
    "PATH=bin\0HOME=home/u\0NEW_KEY=new\0PWD=elsewhere\0chatter\0BAD KEY=x\0",
  ]);
  const env = { PATH: "stale", HOME: "home/u", RETIRED_KEY: "old", INLINE_KEY: "kept", PWD: "supervisor" };
  const environment = createEnvironment({ env, spawnImpl });
  await environment.prime();
  expect(await environment.childEnv()).toEqual({ PATH: "bin", HOME: "home/u", NEW_KEY: "new", INLINE_KEY: "kept", PWD: "supervisor" });
});

test("child environment falls back to the supervisor environment and warns once when the shell is unavailable", async () => {
  const env = { MARKER: "supervisor" };
  let warnings = 0;
  const environment = createEnvironment({ env, spawnImpl: () => { throw new Error("no shell"); }, onWarn: () => { warnings++; } });
  expect(await environment.childEnv()).toBe(env);
  expect(await environment.childEnv()).toBe(env);
  expect(warnings).toBe(1);
});

test("a dump without PATH or HOME is rejected as garbage", async () => {
  const env = { MARKER: "supervisor" };
  const environment = createEnvironment({ env, spawnImpl: fakeSpawn(["WELCOME\0EDITOR=vim\0"]) });
  expect(await environment.childEnv()).toBe(env);
});

test("omd children start from a fresh login-shell environment and the Web child is marked supervised", async () => {
  const folder = mkdtempSync(join(root, "omd-env-"));
  const bin = join(folder, "bin"), settings = join(folder, "settings");
  mkdirSync(join(bin, "scripts"), { recursive: true });
  mkdirSync(settings);
  copyFileSync(resolve("bin/scripts/daemon.js"), join(bin, "scripts/daemon.js"));
  copyFileSync(resolve("bin/scripts/daemon-env.js"), join(bin, "scripts/daemon-env.js"));
  copyFileSync(resolve("bin/scripts/daemon-web.js"), join(bin, "scripts/daemon-web.js"));
  writeFileSync(join(bin, "scripts/daemon-projects.js"), `console.log(JSON.stringify({ webRoot: process.cwd(), jobsRoots: [] }));\n`);
  const log = join(folder, "web.log");
  writeFileSync(join(bin, NAMES.cliPrefix), `import { appendFileSync } from "node:fs";
appendFileSync(process.env.OMD_TEST_LOG, JSON.stringify({ fresh: process.env.OMD_FRESH_MARKER ?? null, inline: process.env.OMD_INLINE ?? null, settings: process.env.OMOYA_SETTINGS_DIR ?? null, daemon: process.env.AI_DAEMON ?? null }) + "\\n");
setInterval(() => {}, 10000);
`);
  writeFileSync(join(bin, "scripts/daemon-jobs.js"), "process.exit(0);\n");
  writeFileSync(join(bin, `${NAMES.cliPrefix}d`), `import "./scripts/daemon.js";\n`);
  const child = spawn(process.execPath, [join(bin, `${NAMES.cliPrefix}d`)], {
    cwd: folder,
    env: { ...process.env, SHELL: fakeShell(folder, "OMD_FRESH_MARKER=fresh\0"), OMOYA_SETTINGS_DIR: settings, OMD_TEST_LOG: log, OMD_INLINE: "kept" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((done) => child.once("close", done));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    const deadline = Date.now() + 3500;
    while (!(await Bun.file(log).exists()) && Date.now() < deadline) await Bun.sleep(30);
    const line = (await Bun.file(log).text()).trim().split("\n")[0];
    expect(JSON.parse(line)).toEqual({ fresh: "fresh", inline: "kept", settings, daemon: "1" });
  } finally {
    child.kill("SIGTERM");
    await closed;
    clearTimeout(timeout);
    rmSync(folder, { recursive: true, force: true });
  }
});
