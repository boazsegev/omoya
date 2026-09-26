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
 * The OSC 52 clipboard write: `ESC ] 52 ; c ; <base64> BEL`. Inside
 * tmux the sequence is wrapped in the DCS passthrough (the outer
 * terminal never sees a raw escape from a pane).
 * @param {string} text
 * @param {(chunk: string) => void} write - the terminal sink
 * @returns {boolean} false when the sink itself failed
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
 * Copy text to the system clipboard, best-effort. With `write` (a
 * terminal sink) and OSC 52 not disabled, the escape sequence is the
 * PRIMARY mechanism — assumed supported; the external tools are the
 * fallback for when there is no terminal sink (or osc52 is off).
 * Resolves true when a mechanism accepted the text. Never throws.
 * @param {string} text
 * @param {Object|Function} [options] - a bare FUNCTION is the legacy
 *   `run` injectable (tests)
 * @param {(chunk: string) => void} [options.write] - terminal sink for OSC 52
 * @param {boolean} [options.osc52] - OSC 52 enabled (default true)
 * @param {(cmd: string, args: string[], input: string) => Promise<number>} [options.run] - tool runner (tests)
 * @returns {Promise<boolean>}
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

/** Default clipboard runner: spawn, pipe the text in, resolve the exit code. */
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
