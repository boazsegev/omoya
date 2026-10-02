/* A deliberately bounded TeX math subset, not a KaTeX-compatible parser.
 * AST: row(children), symbol(value), fraction(numerator,denominator),
 * sqrt(body), script(base,sub?,sup?). Unknown commands remain literal.
 * All nodes carry source (the TeX fragment they consume); never HTML.
 */
const SYMBOLS = Object.freeze({ alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", phi: "φ", omega: "ω", Gamma: "Γ", Delta: "Δ", Sigma: "Σ", Omega: "Ω", infty: "∞", pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", to: "→", rightarrow: "→", leftarrow: "←", in: "∈", sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", ldots: "…", sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln" });
const LIMIT = 4096;
const DEPTH = 32;

/**
 * Parse a bounded TeX subset into presentation-independent nodes; unknown commands remain literal.
 * @param {*} source Input converted to a string (nullish values become empty).
 * @returns {{type: string, [key: string]: any}} AST node; over-limit input is returned as one literal symbol.
 * @throws String conversion may throw for hostile values.
 */
export function parseMath(source) {
  const input = String(source ?? "");
  if (input.length > LIMIT) return { type: "symbol", value: input, source: input };
  let pos = 0;
  /**
   * Parse a sequence of atoms, optionally stopping at and consuming a closing brace.
   * @param {number} depth Current recursive nesting depth.
   * @param {boolean} [grouped=false] Whether this row is inside a brace group.
   * @returns {{type: string, children: Array, source: string}} Row AST node.
   */
  function row(depth, grouped = false) {
    const start = pos;
    const children = [];
    while (pos < input.length && (!grouped || input[pos] !== "}")) {
      if (depth > DEPTH) { children.push({ type: "symbol", value: input.slice(pos), source: input.slice(pos) }); pos = input.length; break; }
      if ((input[pos] === "^" || input[pos] === "_") && pos + 1 < input.length && input[pos + 1] !== "}") {
        const marker = input[pos++];
        const script = atom(depth + 1);
        const previous = children.at(-1);
        if (previous && !(previous.type === "script" && previous[marker === "^" ? "sup" : "sub"])) {
          const node = previous.type === "script" ? previous : { type: "script", base: previous, source: previous.source };
          node[marker === "^" ? "sup" : "sub"] = script;
          node.source += marker + script.source;
          children[children.length - 1] = node;
        } else children.push({ type: "symbol", value: marker + script.source, source: marker + script.source });
      } else children.push(atom(depth + 1));
    }
    if (grouped && input[pos] === "}") pos++;
    return { type: "row", children, source: input.slice(start, pos) };
  }
  /**
   * Parse one atom at the current input position, including groups and supported commands.
   * @param {number} depth Current recursive nesting depth.
   * @returns {object} Parsed AST node; depth overflow becomes literal text.
   */
  function atom(depth) {
    const start = pos;
    if (depth > DEPTH) { pos = input.length; return { type: "symbol", value: input.slice(start), source: input.slice(start) }; }
    const char = input[pos++];
    if (char === "\\" && pos >= input.length) return { type: "symbol", value: "\\", source: "\\" };
    if (char === "{") {
      const group = row(depth, true);
      if (input[pos - 1] !== "}") return { type: "symbol", value: input.slice(start, pos), source: input.slice(start, pos) };
      return { ...group, source: input.slice(start, pos) };
    }
    if (char !== "\\") return { type: "symbol", value: char, source: char };
    const command = /^[a-zA-Z]+|^./.exec(input.slice(pos))?.[0] ?? "";
    pos += command.length;
    if (command === "frac" || command === "sqrt") {
      /** Parse a required braced command argument, or return null if absent/incomplete. */
      const required = () => {
        if (input[pos] !== "{") return null;
        const group = atom(depth + 1);
        return group.source.endsWith("}") ? group : null;
      };
      const first = required();
      const second = command === "frac" && first ? required() : null;
      if (first && (command === "sqrt" || second)) return command === "frac"
        ? { type: "fraction", numerator: first, denominator: second, source: input.slice(start, pos) }
        : { type: "sqrt", body: first, source: input.slice(start, pos) };
      return { type: "symbol", value: input.slice(start, pos), source: input.slice(start, pos) };
    }
    if (Object.hasOwn(SYMBOLS, command)) return { type: "symbol", value: SYMBOLS[command], source: input.slice(start, pos) };
    // Unknown macros must not lose braces or pretend to be recognized.
    while (input[pos] === "{") {
      let nesting = 0;
      do { if (input[pos] === "{") nesting++; else if (input[pos] === "}") nesting--; pos++; } while (pos < input.length && nesting > 0);
    }
    return { type: "symbol", value: input.slice(start, pos), source: input.slice(start, pos) };
  }
  return row(0);
}

/**
 * Determine whether a character is preceded by an odd-length run of backslashes.
 * @param {string} text Text containing the character.
 * @param {number} index Character index to inspect.
 * @returns {boolean} True when the character is escaped.
 */
function isEscaped(text, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
  return count % 2 === 1;
}

/**
 * Build the result record for a delimited inline-math span.
 * @param {string} input Complete source text.
 * @param {number} start Opening delimiter index.
 * @param {number} end Closing delimiter index.
 * @param {number} width Opening delimiter width.
 * @returns {{index: number, raw: string, text: string, tree: object}} Span and parsed AST; calls parseMath.
 */
function mathMatch(input, start, end, width) {
  const raw = input.slice(start, end + width);
  const text = input.slice(start + width, end);
  return { index: start, raw, text, tree: parseMath(text) };
}

/**
 * Check whether a dollar sign followed by a number plausibly opens math rather than a price.
 * @param {string} input Complete source text.
 * @param {number} index Dollar-sign index.
 * @returns {boolean} True when an operator-like continuation makes the opener plausible.
 */
function currencyOpener(input, index) {
  const number = /^\d+(?:[.,]\d+)?/.exec(input.slice(index + 1))?.[0];
  if (!number) return false;
  // A numeric opener is math only when an operator follows its first
  // number. Ambiguous $2$ and prices ($2/$10, $13/day) stay literal.
  const next = input[index + 1 + number.length] ?? "";
  return !next || !"+*^=_({\\-".includes(next);
}

/**
 * Find the first inline math span delimited by \\(...\\) or $...$; conservatively leave prices literal.
 * @param {*} text Source converted to a string (nullish values become empty).
 * @returns {{index: number, raw: string, text: string, tree: object}|null} First span and parsed AST, or null if none is found.
 * @throws String conversion may throw for hostile values.
 */
export function findInlineMath(text) {
  const input = String(text ?? "");
  for (let i = 0; i < input.length; i++) {
    const explicit = input.startsWith("\\(", i) && !isEscaped(input, i);
    const dollar = input[i] === "$" && input[i + 1] !== "$" && input[i - 1] !== "$"
      && !isEscaped(input, i) && !currencyOpener(input, i);
    if (!explicit && !dollar) continue;
    const width = explicit ? 2 : 1;
    if (!input[i + width] || /\s|`/.test(input[i + width])) continue;
    for (let j = i + width + 1; j < input.length; j++) {
      if (input[j] === "\n" || input[j] === "`") break;
      if (explicit) {
        if (input.startsWith("\\)", j) && !isEscaped(input, j) && !/\s/.test(input[j - 1])) return mathMatch(input, i, j, width);
      } else if (input[j] === "$" && !isEscaped(input, j)) {
        // Do not skip a price-like dollar and pair with a later one.
        if (input[j + 1] === "$" || /\s/.test(input[j - 1]) || /\d/.test(input[j + 1] ?? "")) break;
        return mathMatch(input, i, j, width);
      }
    }
  }
  return null;
}

/**
 * Find a complete, line-delimited display-math block; an unclosed block is not consumed.
 * @param {string[]} lines Source lines.
 * @param {number} start Candidate opening-line index.
 * @returns {{end: number, text: string, source: string, tree: object}|null} Block data and parsed AST, or null.
 */
export function mathBlockAt(lines, start) {
  const close = lines[start] === "$$" ? "$$" : lines[start] === "\\[" ? "\\]" : null;
  if (!close) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== close) end++;
  if (end === lines.length) return null;
  const text = lines.slice(start + 1, end).join("\n");
  return { end, text, source: lines.slice(start, end + 1).join("\n"), tree: parseMath(text) };
}

/**
 * Convert a math AST node to a plain-text fallback representation.
 * @param {object|null|undefined} node Math AST node; nullish input produces an empty string.
 * @returns {string} Plain-text rendering; recursively visits child nodes.
 */
export function mathText(node) {
  if (!node) return "";
  if (node.type === "symbol") return node.value;
  if (node.type === "fraction") return `(${mathText(node.numerator)})/(${mathText(node.denominator)})`;
  if (node.type === "sqrt") return `√(${mathText(node.body)})`;
  if (node.type === "script") {
    const scripted = (child, marker) => child ? marker + (child.type === "row" && child.children.length > 1 ? `{${mathText(child)}}` : mathText(child)) : "";
    return mathText(node.base) + scripted(node.sub, "_") + scripted(node.sup, "^");
  }
  return (node.children ?? []).map(mathText).join("");
}
