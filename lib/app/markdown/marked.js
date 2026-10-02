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
 * Load the optional `marked` engine once and cache the result.
 *
 * @param {void} [none] This function accepts no arguments.
 * @returns {Promise<object|null>} Resolves to the module's `marked` export,
 *   its default export, or null when the module cannot be loaded or has
 *   neither export.
 * @throws {never} Import failures are caught and represented by null.
 * @effects Caches the resolved engine or null; subsequent calls do not
 *   repeat the dynamic import.
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
