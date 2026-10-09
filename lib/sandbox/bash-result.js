const MAX_OUTPUT = 50_000;

/** Format captured shell streams the same way as foreground bash. */
export function bashResult(stdout, stderr, code) {
  let text = stdout.trimEnd();
  if (stderr.trim() !== "") text += `${text === "" ? "" : "\n"}[stderr]\n${stderr.trimEnd()}`;
  if (text.length > MAX_OUTPUT) {
    const half = Math.floor(MAX_OUTPUT / 2);
    text = `${text.slice(0, half)}\n[… ${text.length - MAX_OUTPUT} characters elided …]\n${text.slice(-half)}`;
  }
  text ||= "(no output)";
  if (code !== 0) text = `[exit code ${code ?? "?"}]\n${text}`;
  return text;
}
