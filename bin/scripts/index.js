/**
 * bin/scripts/index.js — derive the wrapper set for a namespace.
 *
 * The executable IMPLEMENTATIONS live in this folder (bin/scripts/*);
 * the bin folder itself holds only tiny generated shims that forward to
 * them. Both `bun bin/scripts/rename` and any consumer that wants the
 * current wrapper set use this one module — the mapping is declared
 * exactly once.
 *
 * Names carry NO namespace knowledge: the prefix is applied by callers.
 */
import { NAMES } from "../../lib/namespace.js";

/** Every shim target, unprefixed. */
export const SCRIPT_NAMES = Object.freeze(["app", "agent", "jobs", "io", "tool", "skills", "tools2bash"]);

/** The names ALSO written without the prefix (wrapped twice). */
export const DOUBLE_WRAPPED = Object.freeze(["skills", "tools2bash"]);

/** The app command name: exactly the bare prefix. */
export const SHORT_ALIAS = NAMES.cliPrefix;

/** The default wrapper prefix (NAMES owns it). */
export const CLI_PREFIX = NAMES.cliPrefix;

/** The shebang line, assembled so no absolute path literal sits in source. */
const SHEBANG = `#!${["", "usr", "bin", "env"].join("/")} bun`;

/** The one shim body (a plain module specifier — robust from the bin folder). */
const shim = (target) => `${SHEBANG}\nimport "./scripts/${target}";\n`;

/**
 * The wrapper map for a namespace: file name -> shim body.
 * Prefixed wrappers cover every script (<prefix>-agent included — the
 * headless agent CLI), DOUBLE_WRAPPED also stand alone, and the app
 * command targets the interactive app at both the bare prefix (short form)
 * and the full package name when the names differ. There are no other app
 * aliases.
 * @param {string} [prefix] - the wrapper prefix (default: NAMES.cliPrefix)
 * @param {string} [fullName] - the lowercase full package name
 * @returns {Record<string, string>}
 */
export function wrapperMap(prefix = NAMES.cliPrefix, fullName = NAMES.namespace) {
  const map = {};
  for (const name of SCRIPT_NAMES) map[`${prefix}-${name}`] = shim(name);
  map[prefix] = shim("app"); // short app command
  map[fullName] = shim("app"); // full app command (same entry when equal)
  for (const name of DOUBLE_WRAPPED) map[name] = shim(name); // also without the prefix
  return map;
}

/** The file names the bin folder should hold for a namespace (excluding scripts/). */
export function wrapperNames(prefix = NAMES.cliPrefix, fullName = NAMES.namespace) {
  return Object.keys(wrapperMap(prefix, fullName));
}
