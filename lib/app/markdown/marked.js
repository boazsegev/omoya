/**
 * lib/markdown/marked.js — the optional `marked` engine (private to
 * Markdown): a guarded dynamic import, attempted once at call time.
 *
 * NOT a project dependency: `marked` is never declared, never required
 * to run, and the project still ships no package.json. When it doesn't
 * resolve (the common case), callers fall back to the builtin engine
 * (lib/markdown/lexer.js). This is the project's one approved
 * zero-deps exception (see README.md): test/cli-nodeps.test.js carves
 * out exactly this file's `"marked"` specifier as the sole allowed
 * non-relative import in the project.
 */

let markedModule; // undefined = not attempted yet; null = attempted, unresolved

/**
 * @returns {Promise<object|null>} the `marked` module's `marked`
 *   export when it resolves, null otherwise (cached — the attempt is
 *   never repeated)
 */
export async function loadMarked() {
  if (markedModule !== undefined) return markedModule;
  try {
    const mod = await import("marked");
    markedModule = mod?.marked ?? mod?.default ?? null;
  } catch {
    markedModule = null;
  }
  return markedModule;
}
