/** Shared host-side OAuth primitives used by MCP auth and application login. */
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Generate an unpredictable PKCE verifier and its SHA-256 base64url challenge.
 * @returns {{verifier: string, challenge: string}} Fresh strings, owned by caller.
 * @throws {Error} If cryptographic random generation or hashing fails; retry is safe.
 */
export function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Launch a URL in the system browser without awaiting its lifetime.
 * @param {string} url URL to open; caller validates its origin and scheme.
 * @returns {boolean} Whether process spawning succeeded (not browser completion).
 * @effects Starts an unref'd detached process; repeated calls may open tabs.
 */
export function openInBrowser(url) {
  const opener = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {});
    return true;
  } catch {
    return false;
  }
}
