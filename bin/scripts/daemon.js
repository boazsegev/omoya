#!/usr/bin/env bun
/** Library-free POSIX supervisor: every Web launch and job scan is a new Bun process. */
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createEnvironment } from "./daemon-env.js";

const NAME = basename(process.argv[1] ?? "") || "daemon";
const APP = join(fileURLToPath(new URL("../", import.meta.url)), NAME.slice(0, -1));
const WEB = fileURLToPath(new URL("./daemon-web.js", import.meta.url));
const PROJECTS = fileURLToPath(new URL("./daemon-projects.js", import.meta.url));
const JOBS = fileURLToPath(new URL("./daemon-jobs.js", import.meta.url));
const INTERVAL = 300_000;
function log(message) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${pad(now.getFullYear() % 100)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  console.error(`(${NAME}:${process.pid}) ${date} ${time} ${message}`);
}
const help = `${NAME} — supervise the Web app and scheduled Jobs
Usage: ${NAME} [--host <host>] [--port <port>] [--help]

Starts Web in the first available pinned project, or the launch folder when
none is available. Checks available pinned projects (or the launch folder
if none is pinned) for ai-jobs/; each eligible project gets its own fresh
Jobs child. Projects run in parallel, immediately and 5 minutes after all
children finish. Each Web restart is also a fresh child; the supervisor
imports no application library code. Ctrl-C/SIGTERM stops tracked children.

  --host <host>  Web bind host (passed to the app's --serve command)
  --port <port>  Web port (default: 9900)
  --help, -h     Show this text and exit

Every Web exit restarts Web in a fresh process after a capped delay; only a
signal sent directly to ${NAME} stops the supervisor and its children.
Jobs are best-effort and have no cross-process lock: avoid multiple ${NAME}
instances or concurrent Jobs scans for the same projects.

Every child starts from a fresh login-shell environment ($SHELL -l -i), so
profile edits such as new API keys apply to the next Web restart or Jobs
scan, and keys retired from the profile are removed. Variables that only
exist in this process's environment (inline overrides) pass through
unchanged.
`;

function parse(argv) {
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") return { help: true };
    if (argv[i] !== "--host" && argv[i] !== "--port") throw new Error(`unknown flag: ${argv[i]}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argv[i - 1]}`);
    if (argv[i - 1] === "--port" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error("--port must be between 1 and 65535");
    args.push(argv[i - 1], value);
  }
  return { args };
}

async function projects() {
  try {
    const { code, signal, output } = await launch(process.execPath, [PROJECTS], process.cwd(), { capture: true });
    if (stopping) return null;
    if (code !== 0 || signal) throw new Error(`project discovery exited (${signal ?? code})`);
    const result = JSON.parse(output);
    if (typeof result.webRoot !== "string" || !Array.isArray(result.jobsRoots) || !result.jobsRoots.every((root) => typeof root === "string")) throw new Error("invalid project discovery result");
    return result;
  } catch (error) {
    log(`cannot discover projects: ${error.message}`);
    return { webRoot: process.cwd(), jobsRoots: [] };
  }
}

let stopping = false;
const waits = new Set();
const children = new Set();
function stop() {
  if (stopping) return;
  stopping = true;
  for (const endWait of [...waits]) endWait();
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
  }
}
function pause(ms) {
  if (stopping) return Promise.resolve();
  return new Promise((done) => {
    const endWait = () => { clearTimeout(timer); waits.delete(endWait); done(); };
    const timer = setTimeout(endWait, ms);
    waits.add(endWait);
  });
}
async function launch(file, args, cwd, { capture = false } = {}) {
  if (stopping) return { code: 0, signal: "SIGTERM", output: "" };
  const env = await environment.childEnv();
  if (stopping) return { code: 0, signal: "SIGTERM", output: "" };
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env: { ...env, PWD: cwd }, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", detached: true });
    let output = "";
    if (capture) child.stdout.on("data", (data) => { output += data; });
    children.add(child);
    child.once("error", (error) => log(`${file}: ${error.message}`));
    child.once("close", (code, signal) => { children.delete(child); done({ code, signal, output }); });
  });
}

async function run() {
  const webArgs = ["--serve", ...options.args];
  let failures = 0;
  while (!stopping) {
    const result = await projects();
    if (stopping) return;
    const { webRoot } = result;
    if(process.cwd() == webRoot)
      log(`starting Web in ${webRoot}`);
    else
      log(`starting Web service for all projects`);
    const started = Date.now();
    const { code, signal } = await launch(process.execPath, [WEB, webRoot, APP, ...webArgs], webRoot);
    if (stopping) return;
    failures = Date.now() - started > 60_000 ? 1 : failures + 1;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(failures - 1, 5)));
    log(`Web exited (${signal ?? code}); restarting in ${delay}ms`);
    await pause(delay);
  }
}
async function checks() {
  while (!stopping) {
    const result = await projects();
    if (stopping) return;
    const { jobsRoots } = result;
    await Promise.all(jobsRoots.map(async (root) => {
      const { code, signal } = await launch(process.execPath, [JOBS, root], root);
      if (!stopping && (code !== 0 || signal)) log(`Jobs scan in ${root} exited (${signal ?? code})`);
    }));
    await pause(INTERVAL);
  }
}

const environment = createEnvironment({ onWarn: () => log("cannot read a fresh login-shell environment; children inherit the supervisor's environment") });

let options;
try { options = parse(process.argv.slice(2)); }
catch (error) { log(`${error.message} (see --help)`); process.exit(1); }
if (options.help) {
  process.stdout.write(help);
} else {
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await environment.prime();
  await Promise.all([run(), checks()]);
  // Detached process groups can contain subprocesses after their direct child exits.
  // Do not signal unowned PIDs: only still-tracked groups are stopped above.
}
