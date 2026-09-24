/**
 * website/lib/search.js — build the static client-side search index.
 * Entries: {t: title, u: url, p: parentPath, s: sectionHint, x: searchText}.
 * The browser loads this JSON once and scores it locally — no external
 * service, no dependencies.
 */

/** Collapse whitespace and cap length so the index stays small. */
function clean(text, max = 1500) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {Array<{title: string, url: string, text: string}>} pageEntries
 * @param {object|null} data - collect()'s JSON document (adds symbol entries)
 * @returns {{generated: string, entries: Array}}
 */
export function searchIndex(pageEntries, data, generated) {
  const entries = pageEntries.map((e) => ({
    t: e.title, u: e.url, p: e.url, s: "", x: clean(e.text),
  }));
  for (const mod of data?.modules ?? []) {
    const base = `/api/${mod.name.toLowerCase()}/`;
    for (const symbol of mod.exports) {
      if (symbol.doc?.description) {
        entries.push({
          t: `${mod.name}.${symbol.name}`, u: `${base}#${symbol.name}`, p: base,
          s: mod.name, x: clean(`${symbol.signature ?? ""} ${symbol.doc.description}`, 400),
        });
      }
      // Class members are API points too: a module-namesake class's member
      // is addressable as Module.member (Agent.onEvent), any other class's
      // as Module.Class.member (Agent.SessionStore.append).
      const seen = new Set();
      for (const member of symbol.members ?? []) {
        if (!member.doc?.description || seen.has(member.name)) continue;
        seen.add(member.name);
        const title = symbol.name === mod.name
          ? `${mod.name}.${member.name}`
          : `${mod.name}.${symbol.name}.${member.name}`;
        const anchor = `${symbol.name}-${member.name}`;
        entries.push({
          t: title, u: `${base}#${anchor}`, p: base,
          s: `${mod.name}.${symbol.name}`, x: clean(`${member.signature ?? ""} ${member.doc.description}`, 400),
        });
      }
    }
  }
  return { generated, entries };
}
