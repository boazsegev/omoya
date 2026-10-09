/** Fresh login-shell environments for supervised children (namespace-neutral helper). */
import { spawn } from "node:child_process";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Shell bookkeeping keys a dump must not override (the launch sets the child's cwd). */
const ENV_DROP = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const TIMEOUT = 10_000;

/**
 * Dump one fresh login-shell environment (`$SHELL -l -i -c "env -0"`: login and
 * interactive startup files, NUL-separated so values may contain newlines).
 * @param {object} [options] shell/timeout/spawnImpl overrides (tests).
 * @returns {Promise<object|null>} The parsed environment, or null when the shell is unavailable, times out, or answers garbage.
 */
export function loginEnvironment({ shell = process.env.SHELL || "/bin/sh", timeout = TIMEOUT, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(shell, ["-l", "-i", "-c", "env -0"], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(null); return; }
    let output = "";
    let expired = false;
    const timer = setTimeout(() => { expired = true; try { child.kill("SIGKILL"); } catch { /* already exited */ } }, timeout);
    child.stdout.on("data", (data) => { output += data; });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", () => {
      clearTimeout(timer);
      if (expired) { resolve(null); return; }
      const env = {};
      for (const entry of output.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq < 1) continue; // profile chatter without a key
        const key = entry.slice(0, eq);
        if (ENV_NAME.test(key) && !ENV_DROP.has(key)) env[key] = entry.slice(eq + 1);
      }
      resolve(env.PATH === undefined && env.HOME === undefined ? null : env);
    });
  });
}

/**
 * Track profile-managed keys across dumps so keys retired from the user's
 * startup files leave supervised children while supervisor-only values
 * (inline overrides) survive. prime() takes the startup baseline: keys a
 * later dump no longer exports count as retired.
 * @param {object} [options] env plus loginEnvironment overrides (tests); onWarn fires once when a dump fails.
 * @returns {{prime: Function, childEnv: Function}} prime() captures the baseline; childEnv() resolves one child's environment.
 */
export function createEnvironment({ env = process.env, onWarn = () => {}, ...options } = {}) {
  let managed = new Set();
  let warned = false;
  const childEnv = async () => {
    const fresh = await loginEnvironment(options);
    if (fresh === null) {
      if (!warned) { warned = true; onWarn(); }
      return env;
    }
    const out = { ...env };
    for (const key of managed) if (!(key in fresh)) delete out[key];
    managed = new Set(Object.keys(fresh));
    return { ...out, ...fresh };
  };
  return { prime: childEnv, childEnv };
}
