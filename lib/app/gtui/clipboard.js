/**
 * lib/gtui/clipboard.js — the system clipboard sink (generic terminal
 * primitive, ported from the retired lib/tui-helpers/clipboard.js).
 * PRIMARY: the OSC 52 escape sequence — the terminal is assumed to
 * support it (works over SSH, no X/Wayland tooling needed).
 * FALLBACK: pbcopy (macOS), wl-copy, xclip, xsel, clip.exe. Never
 * throws.
 */

import { execFile } from "node:child_process";

/**
 * Write text to the clipboard using the OSC 52 terminal escape sequence:
 * `ESC ] 52 ; c ; <base64> BEL`. Inside tmux, wraps the sequence in DCS
 * passthrough. Converts `text` to a string and UTF-8/base64-encodes it.
 * @param {string} text Text to copy; coerced with `String()`.
 * @param {(chunk: string) => void} write Terminal sink that receives the escape sequence.
 * @returns {boolean} `true` if the sink call succeeds, otherwise `false` if it throws.
 */
export function osc52Copy(text, write) {
  const payload = Buffer.from(String(text), "utf8").toString("base64");
  const sequence = `\x1b]52;c;${payload}\x07`;
  const framed = process.env.TMUX
    ? `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`
    : sequence;
  try {
    write(framed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text to the system clipboard on a best-effort basis. Uses OSC 52
 * first when `write` is a function and OSC 52 is enabled; otherwise, or
 * when the sink throws, tries platform clipboard commands in order. A
 * failed/rejected command is treated as a failed attempt. Never rejects.
 * @param {string} text Text to copy (passed to the selected mechanism).
 * @param {Object|Function} [options={}] Options object, or a bare function as the legacy `run` injectable.
 * @param {(chunk: string) => void} [options.write] Terminal sink for the OSC 52 sequence.
 * @param {boolean} [options.osc52=true] Whether OSC 52 is enabled; only the exact value `false` disables it.
 * @param {(cmd: string, args: string[], input: string) => Promise<number>} [options.run=spawnAndWait] Clipboard command runner; zero means success.
 * @returns {Promise<boolean>} Resolves `true` when OSC 52 or a command succeeds, otherwise `false`.
 */
export function copyToClipboard(text, options = {}) {
  const { write, osc52 = true, run = spawnAndWait } =
    typeof options === "function" ? { run: options } : options;
  if (osc52 !== false && typeof write === "function" && osc52Copy(text, write)) {
    return Promise.resolve(true);
  }
  const candidates = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["clip.exe", []],
  ];
  const attempt = async (i) => {
    if (i >= candidates.length) return false;
    const [cmd, args] = candidates[i];
    const code = await run(cmd, args, text).catch(() => -1);
    return code === 0 ? true : attempt(i + 1);
  };
  return attempt(0);
}

/**
 * Run a clipboard command, piping the input text to its stdin and enforcing
 * a five-second process timeout.
 * @param {string} cmd Executable name passed to `execFile`.
 * @param {string[]} args Arguments passed to the executable.
 * @param {string} input Text written to the child's stdin.
 * @returns {Promise<number>} Resolves with `0` on successful process exit.
 * @throws {Error} Rejects if spawning or execution reports an error, including timeout.
 */
function spawnAndWait(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve(0);
    });
    child.on("error", reject);
    child.stdin?.end(input, () => {});
  });
}
