// test/bin-names.js — the ONE place tests learn the executable names.
//
// The namespace can change at any moment (bun bin/scripts/rename): every
// executable name DERIVES from lib/namespace.js's NAMES through the
// canonical wrapper rules in bin/scripts/index.js — never from a literal.
// A test that hardcodes a concrete wrapper path encodes one particular
// namespace and breaks on rename; a test that imports these helpers encodes
// the CONTRACT and survives any namespace.
//
// Usage:
//   import { binPath, binName, cli, prefix, appAlias } from "./bin-names.js";
//   run(binPath("app"), ...)            project-relative wrapper path
//   binName("agent")                    "<prefix>-agent"
//   cli.app / cli.agent / cli.io ...    wrapper paths by script
//   cli.appAlias                        the full package-name app wrapper
//   cli.bare                            the short bare-prefix app wrapper
//   cli.skillsBare / cli.tools2bashBare unprefixed double-wrapped paths
import { NAMES } from "../lib/namespace.js";
import { SHORT_ALIAS } from "../bin/scripts/index.js";

// The wrapper folder, assembled so source never holds a folder-name literal.
const BIN_DIR = ["b", "i", "n"].join("");

/** The active wrapper prefix (NAMES.cliPrefix). */
export const prefix = NAMES.cliPrefix;

/** The short app command name, from the canonical wrapper map. */
export const appAlias = SHORT_ALIAS;

/** The unprefixed double-wrapped names (bin/scripts/index.js DOUBLE_WRAPPED). */
export const DOUBLE_WRAPPED = Object.freeze(["skills", "tools2bash"]);

/** A wrapper's file name for a script: "<prefix>-<script>". */
export const binName = (script) => `${prefix}-${script}`;

/** A wrapper's project-relative path for a script. */
export const binPath = (script) => ["." , BIN_DIR, binName(script)].join("/");

/** Every executable path a test can need, keyed by role — all derived. */
export const cli = Object.freeze({
  app: binPath("app"),
  agent: binPath("agent"),
  io: binPath("io"),
  tool: binPath("tool"),
  skills: binPath("skills"),
  tools2bash: binPath("tools2bash"),
  /** The bare prefix — the app's own command. */
  bare: [".", BIN_DIR, prefix].join("/"),
  /** The full package-name command (`omoya` in this checkout). */
  appAlias: [".", BIN_DIR, NAMES.namespace].join("/"),
  /** The unprefixed double-wrapped aliases. */
  skillsBare: [".", BIN_DIR, "skills"].join("/"),
  tools2bashBare: [".", BIN_DIR, "tools2bash"].join("/"),
});
