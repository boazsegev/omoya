/** File-name glob matching for read's folder listing and content search. */

/**
 * Match a relative file path (gitignore/standard glob semantics):
 * `*` and `?` never cross a `/` — only `**` does. A pattern without
 * `/` matches the path's basename; a pattern containing `/` matches
 * the whole relative path. Supports simple `{a,b}` alternatives.
 */
export function matchesGlob(relativePath, pattern) {
  if (!pattern) return true;
  if (typeof pattern !== "string") throw new Error("glob must be a string");
  const target = pattern.includes("/") ? relativePath : relativePath.split("/").at(-1);
  try {
    return new RegExp(`^${globSource(pattern)}$`).test(target);
  } catch {
    throw new Error("Invalid glob. Use *, ?, **, or {a,b} alternatives.");
  }
}

function globSource(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++; // "**" — the only segment that may cross a "/"
        if (pattern[i + 1] === "/") { i++; source += "(?:.*\u002f)?"; }
        else if (pattern[i + 1] === undefined) source += "(?:\u002f.*)?"; // trailing "**" = everything below
        else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) source += "\\{";
      else {
        const choices = pattern.slice(i + 1, end).split(",").map(globSource);
        source += `(?:${choices.join("|")})`;
        i = end;
      }
    } else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return source;
}
