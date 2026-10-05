// A Bun test process's env/fetch patches are not inherited by spawned scripts.
// Inject the same fetch guard before every child Bun entry point, and forward
// the sanitized test environment even when Bun.spawn omits `env`.
import { resolve } from "node:path";

const childPreload = resolve(import.meta.dir, "child-isolation.js");
const bunExecutable = process.execPath;

function isBun(command) {
  const executable = Array.isArray(command) ? command[0] : command?.cmd?.[0];
  return executable === "bun" || executable === bunExecutable;
}

function isolatedCommand(command) {
  const argv = Array.isArray(command) ? command : command.cmd;
  // --preload applies only to this invocation (including when cwd changes).
  const cmd = [argv[0], "--preload", childPreload, ...argv.slice(1)];
  return Array.isArray(command) ? cmd : { ...command, cmd };
}

export function isolateBunChildren() {
  for (const name of ["spawn", "spawnSync"]) {
    const spawn = Bun[name];
    Bun[name] = (command, options = {}) => {
      const cmd = isBun(command) ? isolatedCommand(command) : command;
      const env = options.env ?? process.env;
      return spawn(cmd, { ...options, env });
    };
  }
}
