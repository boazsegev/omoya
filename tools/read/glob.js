/** Bounded glob matching, without user-controlled regular expressions on the host event loop. */
const MAX_WORK = 1000000;
const MAX_ALTERNATIVES = 128;

function alternatives(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close < 0) return [pattern];
  const options = pattern.slice(open + 1, close).split(",");
  if (options.some((option) => option.includes("{"))) throw new Error("Nested glob alternatives are not supported");
  const out = [];
  for (const option of options) {
    out.push(...alternatives(pattern.slice(0, open) + option + pattern.slice(close + 1)));
    if (out.length > MAX_ALTERNATIVES) throw new Error("Glob alternatives exceed 128");
  }
  return out;
}

function tokens(pattern) {
  const out = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; out.push({ kind: "prefix" }); }
      else out.push({ kind: "any" });
    } else if (pattern[i] === "*") out.push({ kind: "segment" });
    else if (pattern[i] === "?") out.push({ kind: "one" });
    else out.push({ kind: "literal", value: pattern[i] });
  }
  return out;
}

function match(target, pattern, work) {
  let current = new Uint8Array(target.length + 1);
  current[0] = 1;
  for (const token of tokens(pattern)) {
    const next = new Uint8Array(target.length + 1);
    let active = false;
    for (let i = 0; i <= target.length; i++) {
      if (++work.count > MAX_WORK) throw new Error("Glob matching work budget exhausted; simplify the pattern");
      if (token.kind === "any" || token.kind === "segment" || token.kind === "prefix") {
        if (token.kind === "segment" && target[i - 1] === "/") active = false;
        active ||= Boolean(current[i]);
        next[i] = token.kind === "prefix" ? Number(Boolean(current[i]) || (active && target[i - 1] === "/")) : Number(active);
      } else if (i < target.length && current[i] && (token.kind === "one" ? target[i] !== "/" : target[i] === token.value)) next[i + 1] = 1;
    }
    current = next;
  }
  return Boolean(current[target.length]);
}

/** Validate bounded brace expansion even when no candidate file exists. */
export function validateGlob(pattern) {
  if (typeof pattern !== "string" || pattern.length > 4096) throw new Error("glob must be a string of at most 4096 characters");
  alternatives(pattern);
}

/** Slashless globs match basenames; leading slash anchors; * and ? never cross '/', ** does. */
export function matchesGlob(relativePath, pattern) {
  if (!pattern) return true;
  validateGlob(pattern);
  const anchored = pattern.startsWith("/");
  const value = anchored ? pattern.slice(1) : pattern;
  const target = anchored || value.includes("/") ? relativePath : relativePath.split("/").at(-1);
  const work = { count: 0 };
  return alternatives(value).some((option) => match(target, option, work));
}
