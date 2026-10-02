/**
 * lib/sandbox/os.js — the OS-LEVEL write sandbox (shared by every
 * tool that opts in, not just bash).
 *
 * The path-traversal GUARD (tools/guard/paths.js) is static analysis —
 * it reads arguments and refuses what LOOKS like an escape, but a
 * sufficiently obfuscated command (hex-encoded paths, runtime-assembled
 * strings) can slip past any static check. This module is the
 * ENFORCEMENT beneath it: a tool's process runs inside an OS sandbox
 * whose kernel denies every write outside the working folder, no
 * matter how the tool spells its paths.
 *
 * Mechanisms (first available wins, probed once per process):
 *   - macOS: seatbelt (`/usr/bin/sandbox-exec`, shipped with the OS —
 *     deprecated by Apple, still fully functional): an SBPL profile
 *     that allows everything EXCEPT writes, which are allowed only in
 *     the working folder and the tmp/device conventions. Probed for
 *     APPLICABILITY, not mere existence: a process already inside a
 *     seatbelt (a host that jails the agent itself, a jailed test
 *     run) CANNOT apply another profile (`sandbox_apply: Operation
 *     not permitted`). Nesting is NOT "no mechanism" — the outer
 *     jail already confines writes — so it reports "delegated": the
 *     wrap is a passthrough (the kernel still denies outside writes
 *     via the outer profile), and the Agent does NOT force safe mode;
 *   - Linux: bubblewrap (`bwrap`) when installed: the host root
 *     read-only, the working folder bound read-write over it;
 *   - otherwise: no wrapper — the guard alone (honest, never pretend).
 * chroot is deliberately NOT a mechanism: it needs root (an agent
 * never has it) and a populated root tree (bin, libs) — the wrong
 * tool for a per-command jail.
 *
 * Reads stay allowed everywhere: builds and test runners read system
 * headers, runtime installs, and shared libraries constantly — the
 * jail guards WRITES (mutation is the damage channel); the static
 * guard already refuses the outside READS it can see.
 *
 * There is NO public opt-out: the wrapper cannot be disabled by
 * configuration or a public environment flag — the sandbox is the
 * enforcement layer of the whole trust model, so when no mechanism is
 * available the Agent FORCES safe mode (read-only tools only) instead
 * of running mutations unjailed (see lib/agent.js).
 */

import { existsSync } from "node:fs";
import { NAMES } from "../namespace.js";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";

/** Find the first existing candidate executable in PATH directories.
 * @param {string} name - executable name to search for
 * @returns {string|null} candidate path, or null if none exists
 * @effects Reads process.env.PATH and checks candidates with existsSync.
 */
function onPath(name) {
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Build a seatbelt profile allowing reads everywhere and writes only
 * within the folder and configured temporary/device paths.
 * @param {string} cwd - folder in which writes are permitted
 * @returns {string} SBPL profile text
 * @effects Reads process.env.TMPDIR when set.
 */
function seatbeltProfile(cwd) {
  const allows = [cwd, "/dev", "/dev/null", "/private/tmp", "/tmp",
    "/private/var/folders", process.env.TMPDIR]
    .filter((p) => typeof p === "string" && p !== "")
    .map((p) => `(subpath "${p}")`)
    .join(" ");
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${allows})`;
}

/** seatbelt only: existence is not APPLICABILITY — a process already
 *  inside a seatbelt (a jailed host, a jailed test run) cannot apply
 *  another profile. Probe once with a permissive profile on a trivial
 *  program; a failure means an OUTER jail confines us already (the
 *  realistic cause of sandbox_apply refusing — enforcement exists,
 *  it is just not ours to add).
 * @param {string} bin - path to seatbelt executable
 * @returns {boolean} whether the permissive test profile can be applied
 * @effects Spawns the executable with a trivial program; returns false if
 *          spawning throws or the process exits unsuccessfully.
 */
function seatbeltApplicable(bin) {
  try {
    const r = spawnSync(bin, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

let probed; // undefined = not probed yet; null = no mechanism; else {kind, bin?}

/** Probe the available mechanism ONCE (the binary's existence doesn't
 *  change mid-process; the test gate is re-read per call). Setting
 *  the namespace OS-sandbox gate to `none` simulates a mechanism-less
 *  platform PER CALL, so tests can flip it between cases regardless of
 *  which test probed first (it can only ever make the environment
 *  MORE restrictive: no wrapper, and the Agent forces safe mode).
 * @returns {{kind: "seatbelt"|"bwrap"|"delegated", bin?: string}|null}
 *          mechanism, or null when unavailable/disabled
 * @effects Reads environment/platform, probes binaries, and caches the result
 *          except when the gate is set to "none".
 */
function probe() {
  if (process.env[NAMES.osSandboxEnv] === "none") return null;
  if (probed !== undefined) return probed;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    probed = seatbeltApplicable("/usr/bin/sandbox-exec")
      ? { kind: "seatbelt", bin: "/usr/bin/sandbox-exec" }
      : { kind: "delegated" }; // an outer seatbelt confines this process already
  } else if (process.platform === "linux") {
    const bwrap = onPath("bwrap");
    probed = bwrap !== null ? { kind: "bwrap", bin: bwrap } : null;
  } else {
    probed = null;
  }
  return probed;
}

/**
 * Is OS write-sandbox ENFORCEMENT in effect for this process — our own
 * mechanism (seatbelt/bwrap) or an OUTER jail we detected (a nested
 * seatbelt confines us already)? A single probe, cached. There is NO
 * opt-out: when false the Agent FORCES safe mode (read-only tools
 * only) — mutation tools run only under active write enforcement.
 * @returns {boolean} whether this process or an outer jail enforces write limits
 * @effects Probes and caches the mechanism; the environment gate can disable
 *          enforcement per call.
 */
export function osSandboxAvailable() {
  return probe() !== null;
}

/**
 * The sandbox mechanism in effect: "seatbelt", "bwrap", "delegated"
 * (an outer jail enforces writes — our wrap is a passthrough), or null
 * (no enforcement — the Agent forces safe mode then).
 * @returns {"seatbelt"|"bwrap"|"delegated"|null} mechanism, or null
 *          when enforcement is unavailable
 * @effects Probes and caches the mechanism; the environment gate can disable
 *          enforcement per call.
 */
export function osSandboxKind() {
  return probe()?.kind ?? null;
}

/**
 * Wrap a program invocation in the OS sandbox: the [file, argv] to
 * spawn — the wrapper and its arguments followed by the original
 * program — or the input unchanged when no mechanism applies. The
 * wrap is built per call with the CURRENT working folder (a session
 * resume may have moved it; the cached probe only remembers the
 * mechanism).
 * @param {string} file - the program to run (e.g. process.execPath)
 * @param {string[]} [args=[]] - its arguments
 * @param {string} [cwd=process.cwd()] - the project folder writes are limited to
 * @param {string} [workingDirectory=cwd] - process working directory within cwd
 * @returns {[string, string[]]} executable and argument vector to spawn
 * @effects Probes/caches the mechanism and uses the supplied paths to build
 *          wrapper arguments.
 */
export function osSandboxWrap(file, args = [], cwd = process.cwd(), workingDirectory = cwd) {
  const mechanism = probe();
  if (mechanism === null || mechanism.kind === "delegated") return [file, args]; // none, or the outer jail enforces already
  if (mechanism.kind === "seatbelt") {
    return [mechanism.bin, ["-p", seatbeltProfile(cwd), file, ...args]];
  }
  return [mechanism.bin, [
    "--die-with-parent",
    "--dev-bind", "/dev", "/dev",
    "--proc", "/proc",
    "--ro-bind", "/", "/",
    "--bind", cwd, cwd, // the project is read-write OVER the read-only root
    "--tmpfs", "/tmp",
    "--setenv", "TMPDIR", "/tmp",
    "--chdir", workingDirectory,
    file, ...args,
  ]];
}
