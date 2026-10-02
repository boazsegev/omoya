/**
 * lib/cli/flags.js — the shared `--flag value` grammar of the three
 * executables (private to CLI). One parser, one error vocabulary.
 */

import { durationParse } from "../util.js";

/**
 * Parse command-line arguments into a flat options object. Value-taking flags
 * use `--name value`; boolean flags use `--name`. `--help` and `-h` return
 * `{help: true}` immediately. Repeated flags overwrite earlier values.
 * Configured duration values are converted with `durationParse`; configured
 * numeric values are converted with `Number` and must be finite and positive.
 * Flag relationships and value-specific transformations remain caller policy.
 *
 * @param {string[]} argv - Arguments to parse, typically `process.argv.slice(2)`.
 * @param {Object} spec - Flag-name configuration.
 * @param {string[]} spec.flags - Names of value-taking flags (required).
 * @param {string[]} [spec.bools=[]] - Names of valueless boolean flags.
 * @param {string[]} [spec.durations=["timeout"]] - Value-taking flag names
 *   converted by `durationParse` when present.
 * @param {string[]} [spec.numbers=["max-turns", "max-tool-calls"]] -
 *   Value-taking flag names converted to finite, positive numbers when present.
 * @returns {Object} Parsed options; values are strings except converted
 *   duration/number values, boolean flags (`true`), or `{help: true}`.
 * @throws {Error} For positional arguments, unknown flags, missing values,
 *   invalid duration values, or configured numbers that are not finite and
 *   positive. Duration errors are prefixed with the flag name.
 * @remarks Synchronous; does not mutate `argv` or `spec`. A help flag
 *   short-circuits parsing and value validation.
 */
export function parseFlags(argv, { flags, bools = [], durations = ["timeout"], numbers = ["max-turns", "max-tool-calls"] }) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    const key = flag.slice(2);
    if (bools.includes(key)) {
      args[key] = true;
      continue;
    }
    if (!flags.includes(key)) {
      throw new Error(`unknown flag: ${flag}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    args[key] = value;
  }
  for (const name of durations) {
    if (args[name] === undefined) continue;
    try {
      args[name] = durationParse(args[name]);
    } catch (err) {
      throw new Error(`--${name}: ${err.message}`);
    }
  }
  for (const name of numbers) {
    if (args[name] === undefined) continue;
    args[name] = Number(args[name]);
    if (!Number.isFinite(args[name]) || args[name] <= 0) {
      throw new Error(`--${name} must be a positive number`);
    }
  }
  return args;
}
