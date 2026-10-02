/** Private skill-body composition: self references select the previous definition. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REFERENCE_DEPTH = 64;

function section(body, range, name) {
  if (!range) return body;
  const lines = body.split(/\r?\n/);
  const [first, last] = range.map(Number);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > lines.length) {
    throw new Error(`Invalid skill line range: ${name}[${range.join("-")}]`);
  }
  return lines.slice(first - 1, last).join("\n");
}

function reference(token) {
  const match = token.trim().match(/^(.+?)\[(\d+)-(\d+)\]$/);
  return match ? { name: match[1].trim(), range: match.slice(2) } : { name: token.trim() };
}

function expand(node, entries, cache, visiting) {
  if (cache.has(node)) return cache.get(node);
  if (visiting.has(node)) throw new Error(`Cyclic skill reference: ${node.name}`);
  if (visiting.size >= MAX_REFERENCE_DEPTH) throw new Error(`Skill reference depth exceeded: ${node.name}`);
  visiting.add(node);
  const body = replaceReferences(node, entries, cache, visiting);
  visiting.delete(node);
  cache.set(node, body);
  return body;
}

function replaceReferences(node, entries, cache, visiting) {
  let size = 0;
  return node.parsed.body.replace(/\{\{([^{}\r\n]+?)\}\}|([^{}]+|[{}])/g, (text, token) => {
    const { name, range } = token === undefined ? {} : reference(token);
    const target = name === node.name ? node.previous : entries.get(name);
    const value = target ? section(expand(target, entries, cache, visiting), range, name) : text;
    size += Buffer.byteLength(value);
    if (size > MAX_BODY_BYTES) throw new Error(`Skill body size exceeded: ${node.name}`);
    return value;
  });
}

/** Return effective entries, retaining only private directory overlays for resources. */
export function composeSkills(entries) {
  const cache = new Map();
  return new Map([...entries].map(([name, entry]) => [name, {
    ...entry,
    parsed: { ...entry.parsed, body: expand(entry, entries, cache, new Set()) },
  }]));
}
