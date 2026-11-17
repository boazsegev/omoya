/** Format a file reference without leaking a host filesystem path.
 * @param {string} path Project-relative file or folder path.
 * @param {string} project Public project name.
 * @param {boolean} local Whether the conversation belongs to this project.
 * @returns {string} Inline-code path, optionally @ inline-code project; inputs are not retained.
 */
export function fileReference(path, project, local) {
  const relative = path.replaceAll("\\", "/") || ".";
  return local ? inlineCode(relative) : `${inlineCode(relative)}@${inlineCode(project)}`;
}

function inlineCode(value) {
  const text = value.replace(/[\r\n]/g, " ");
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}
