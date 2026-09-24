/**
 * website/lib/api.js — render the collected() JSON document into per-module
 * API pages plus overview/architecture/contracts/tools/settings sections.
 * Every symbol, member, typedef, tool schema, and contract source is rendered
 * from generator data — no API prose is copied into this file.
 */
import { escapeHtml, page } from "./html.js";
import { markdownHtml } from "./markdown.js";
import { site } from "../site.js";

/** "Env" → "env", for /api/<slug>/ paths. */
export const slugOf = (name) => name.toLowerCase();

/**
 * The cross-reference index: every documented API point (module export or
 * class member) maps to its page + anchor. Built once per build from
 * collect()'s JSON document, so links are created ONLY for points that
 * actually exist — a mention that matches nothing stays plain code text.
 * Lookup is scoped: a `member` mention inside module M resolves as
 * `M.member` first, then any module's `member`; a `Name.member` mention
 * resolves as `currentModule.Name.member`, then `Name.member`.
 */
export function buildApiLinks(data) {
  // exact dotted path ("Agent.onEvent") → {slug, hash}; bare member name
  // ("onEvent") → same; a bare name shared by several modules is ambiguous
  // and resolves only through the scoped dotted form.
  const exact = new Map();
  const bareCandidates = new Map();
  const register = (path, slug, hash) => {
    exact.set(path, { slug, hash });
    const name = path.split(".").at(-1);
    const key = `${slug}#${hash}`;
    const candidates = bareCandidates.get(name) ?? new Map();
    candidates.set(key, { slug, hash });
    bareCandidates.set(name, candidates);
  };
  for (const mod of data.modules) {
    if (mod.name === "index") continue;
    const slug = slugOf(mod.name);
    for (const symbol of mod.exports) {
      // A class that shares its module's name (Agent in the Agent module) IS
      // the module's namesake: `Agent.EVENT` means the class's static, never
      // the bare "Agent.Agent" path, so register it under the short path.
      const symbolPath = symbol.name === mod.name ? mod.name : `${mod.name}.${symbol.name}`;
      register(symbolPath, slug, symbol.name);
      for (const member of symbol.members ?? []) {
        // Qualify every member anchor by its owning symbol. Multiple classes
        // on one module page commonly share names such as close()/flush().
        const anchor = `${symbol.name}-${member.name}`;
        register(`${symbolPath}.${member.name}`, slug, anchor);
        // A member of the module's same-named class is addressable directly
        // as Module.member (Agent.onEvent for class Agent's method).
        if (symbol.name === mod.name) register(`${mod.name}.${member.name}`, slug, anchor);
      }
    }
  }
  return {
    /** Resolve a mention to {slug, hash}, scoped to the mentioning module.
     *  A dotted mention that matches nothing exactly falls back to its
     *  longest known PREFIX (`Agent.EVENT.START` → `Agent.EVENT`). */
    resolve(mention, moduleName) {
      const bare = bareCandidates.get(mention);
      const direct = mention.includes(".")
        ? exact.get(`${moduleName}.${mention}`) ?? exact.get(mention)
        : exact.get(`${moduleName}.${mention}`) ?? (bare?.size === 1 ? bare.values().next().value : null);
      if (direct) return direct;
      let prefix = mention;
      while (prefix.includes(".")) {
        prefix = prefix.slice(0, prefix.lastIndexOf("."));
        const hit = exact.get(`${moduleName}.${prefix}`) ?? exact.get(prefix);
        if (hit) return hit;
      }
      return null;
    },
  };
}

/** Sidebar entries for every API page, in section order. */
export function apiNavLinks(data) {
  return [
    { href: "/api/", label: "Overview" },
    { href: "/api/architecture/", label: "Architecture" },
    ...data.modules.map((m) => ({ href: `/api/${slugOf(m.name)}/`, label: m.name })),
    { href: "/api/contracts/", label: "Contracts" },
    { href: "/api/tools/", label: "Tool catalog" },
    { href: "/api/settings/", label: "Settings schema" },
  ];
}

/**
 * Link known API mentions inside rendered markdown HTML. Operates on
 * ALREADY-RENDERED html (never raw source) and rewrites only `<code>`
 * spans whose whole text is one identifier path (`onEvent`, `Env.onEvent`,
 * `Agent.SessionStore.append`): those are exactly the API-point mentions.
 * A span inside an existing <a> is left alone (lookahead up to the tag end).
 * Links are root-relative: pages deploy as extensionless clean URLs
 * (`/api/env`), where relative `./env/` would resolve to `/env` — outside
 * the API tree. Same-page references use only a fragment.
 */
export function linkApiReferences(html, links, moduleName) {
  if (!links) return html;
  return String(html).replace(
    /<code>([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3})(\(\))?<\/code>(?![^<]*<\/a>)/g,
    (match, mention, call) => {
      const target = links.resolve(mention, moduleName);
      if (!target) return match;
      const href = target.slug === slugOf(moduleName)
        ? `#${escapeHtml(target.hash)}`
        : `/api/${target.slug}/#${escapeHtml(target.hash)}`;
      return `<a href="${href}"><code>${escapeHtml(mention)}${call ?? ""}</code></a>`;
    },
  );
}

/** One exported symbol as a definition block (signature + doc + params/returns). */
function symbolHtml(symbol, moduleName, links) {
  const qualified = moduleName === "index" ? symbol.name : `${moduleName}.${symbol.name}`;
  const doc = symbol.doc ?? {};
  const prose = (text) => linkApiReferences(markdownHtml(text), links, moduleName);
  const parts = [`<section class="symbol" id="${escapeHtml(symbol.name)}">`,
    `<h3><code>${escapeHtml(symbol.signature ?? qualified)}</code> <span class="kind">${escapeHtml(symbol.kind)}</span></h3>`];
  if (doc.description) parts.push(prose(doc.description));
  if (doc.params?.length) {
    parts.push(`<dl class="params">${doc.params.map((p) =>
      `<dt><code>${escapeHtml(p.name)}</code>${p.type ? ` <span class="type">${escapeHtml(p.type)}</span>` : ""}</dt><dd>${linkApiReferences(escapeHtml(p.description), links, moduleName)}</dd>`).join("")}</dl>`);
  }
  if (doc.returns && (doc.returns.type || doc.returns.description)) {
    parts.push(`<p class="returns">Returns${doc.returns.type ? ` <code>${escapeHtml(doc.returns.type)}</code>` : ""}${doc.returns.description ? ` — ${linkApiReferences(escapeHtml(doc.returns.description), links, moduleName)}` : ""}</p>`);
  }
  if (symbol.from && !symbol.from.endsWith(`/${moduleName.toLowerCase()}.js`)) {
    parts.push(`<p class="from">Defined in <code>${escapeHtml(symbol.from)}</code></p>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** One class/namespace member block. */
function memberHtml(member, moduleName, links, anchor = member.name) {
  const doc = member.doc ?? {};
  return `<section class="symbol member" id="${escapeHtml(anchor)}">
  <h4><code>${escapeHtml(member.signature)}</code> <span class="kind">${escapeHtml(member.kind)}</span></h4>
  ${doc.description ? linkApiReferences(markdownHtml(doc.description), links, moduleName) : ""}
</section>`;
}

/** The exports/members of a module, in render order, shared by the page body
 *  and the sidebar section list so anchors can never drift apart. */
function moduleAnchors(symbol) {
  const seen = new Map();
  return (symbol.members ?? []).map((m) => {
    const count = seen.get(m.name) ?? 0;
    seen.set(m.name, count + 1);
    const base = `${symbol.name}-${m.name}`;
    return { member: m, anchor: count === 0 ? base : `${base}-${count}` };
  });
}

/** A whole public module page: module doc, then every export with members. */
function modulePageBody(mod, links) {
  const exports = mod.exports.map((symbol) => {
    // get/set pairs collect as two same-named members; one anchor can only
    // ever carry one target, so the later blocks get a suffixed id
    const members = moduleAnchors(symbol)
      .map(({ member, anchor }) => memberHtml(member, mod.name, links, anchor)).join("\n");
    return `${symbolHtml(symbol, mod.name, links)}${members}`;
  }).join("\n");
  return `<p class="eyebrow">PUBLIC MODULE · <code>${escapeHtml(mod.file)}</code></p>
<h1>${escapeHtml(mod.name)}</h1>
${mod.doc ? linkApiReferences(markdownHtml(mod.doc), links, mod.name) : ""}
${exports || "<p>This module is a namespace wrapper; its surface is documented on the individual module pages it re-exports.</p>"}`;
}

const moduleCard = (href, name, file, blurb) => `  <a class="card" href="${href}"><article><h3>${escapeHtml(name)}</h3><p><code>${escapeHtml(file)}</code></p><p>${escapeHtml(blurb)}</p></article></a>`;

/** /api/ overview: what the reference is, plus the module index cards. */
function overviewBody(data) {
  return `<p class="eyebrow">GENERATED FROM THE CURRENT SOURCE TREE · ${escapeHtml(data.generated)}</p>
<h1>API reference</h1>
<p class="lede">Every page in this section is generated at build time from the package's public modules, their JSDoc contracts, live tool schemas, and real import edges — never from copied prose. Pick a module below, or browse <a href="/api/architecture/">architecture</a>, <a href="/api/contracts/">contracts</a>, the <a href="/api/tools/">tool catalog</a>, and the <a href="/api/settings/">settings schema</a>.</p>
<div class="grid">
${data.modules.map((m) => moduleCard(`/api/${slugOf(m.name)}/`, m.name, m.file, firstSentence(m.doc))).join("\n")}
</div>`;
}

/** The first sentence of a doc string, for cards and search text. */
function firstSentence(text) {
  const flat = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  const end = flat.search(/[.!?](?:\s|$)/);
  return end < 0 ? flat.slice(0, 200) : flat.slice(0, end + 1);
}

/** /api/architecture/ — layers, import edges, helper groups, executables, IO modes. */
function architectureBody(arch) {
  const layers = arch.layers.map((layer) => `<section class="arch-layer" id="${escapeHtml(slugOf(layer.name))}">
  <h3><a href="/api/${slugOf(layer.name)}/">${escapeHtml(layer.name)}</a> <code>${escapeHtml(layer.file)}</code></h3>
  ${layer.publicDependencies.length ? `<p>Depends on: ${layer.publicDependencies.map((d) => `<a href="/api/${slugOf(d)}/">${escapeHtml(d)}</a>`).join(", ")}</p>` : "<p>Depends on no other public module.</p>"}
  ${layer.helperGroups.map((g) => `<p class="helper">Owns <code>${escapeHtml(g.path)}/</code> (${g.files.length} files${g.label ? ` — ${escapeHtml(g.label)}` : ""})</p>`).join("\n  ")}
</section>`).join("\n");
  const executables = arch.executables.filter((e) => e.doc).map((e) =>
    `<li><code>${escapeHtml(e.name)}</code> — ${escapeHtml(firstSentence(e.doc))}</li>`).join("\n    ");
  const connectors = arch.connectors.map((c) => `<code>${escapeHtml(c.name)}</code>`).join(" ");
  return `<p class="eyebrow">DISCOVERED FROM REAL IMPORT EDGES</p>
<h1>Architecture</h1>
<p class="lede">Public façades, their true dependencies (including lazy-loaded engines), owned helper folders, executables, and built-in IO modes — collected from the source tree on every build.</p>
<h2>Public modules</h2>
${layers}
<h2>Executables</h2>
<ul>
    ${executables}
</ul>
<h2>Built-in IO modes</h2>
<p>${connectors}</p>
<h2>Environment auto-detection</h2>
<p>At startup <a href="/api/env/#Env-detectEndpoints"><code>Env.detectEndpoints()</code></a> lets every loaded provider probe the process environment and the local network. Discoveries are marked <code>dynamic: true</code> — environment-defined endpoints are never persisted, re-detected every startup, and never override an endpoint already configured in settings. No key is ever written to disk by detection.</p>
<table>
  <thead><tr><th>environment</th><th>detected endpoint</th></tr></thead>
  <tbody>
    <tr><td><code>OPENAI_API_KEY</code> (+ optional <code>OPENAI_BASE_URL</code>)</td><td><code>openai</code> (OpenAI Responses)</td></tr>
    <tr><td><code>AZURE_OPENAI_API_KEY</code> (+ required <code>AZURE_OPENAI_BASE_URL</code>)</td><td><code>azure-openai</code> (OpenAI Responses)</td></tr>
    <tr><td><code>XAI_API_KEY</code></td><td><code>xai</code> (OpenAI Responses)</td></tr>
    <tr><td><code>MOONSHOT_API_KEY</code> (+ optional <code>MOONSHOT_BASE_URL</code>)</td><td><code>kimi</code> (Moonshot platform)</td></tr>
    <tr><td><code>KIMI_API_KEY</code></td><td><code>kimi-coding</code> (Kimi for Coding relay)</td></tr>
    <tr><td><code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code> (+ optional <code>ANTHROPIC_BASE_URL</code>)</td><td><code>anthropic</code> (Anthropic Messages)</td></tr>
    <tr><td>Ollama server probe, <code>http://localhost:11434/api/tags</code></td><td><code>ollama</code></td></tr>
    <tr><td>LM Studio server probe, <code>http://localhost:1234/v1/models</code></td><td><code>lm-studio</code> (OpenAI-compatible)</td></tr>
  </tbody>
</table>
<h2>Harness environment variables</h2>
<p>The namespace-derived set the harness itself reads (<code>OMOYA_</code>/<code>omoya</code> become <code>&lt;NS&gt;_</code>/<code>&lt;ns&gt;</code> when the package is renamed; the plain <code>AI_*</code> settings names are the still-honored legacy spellings):</p>
<table>
  <thead><tr><th>variable</th><th>effect</th></tr></thead>
  <tbody>
    <tr><td><code>OMOYA_SETTINGS_DIR</code> / <code>OMOYA_SETTINGS</code> / <code>AI_SETTINGS_DIR</code> / <code>AI_SETTINGS</code></td><td>Override the user settings folder (first non-empty wins; created when missing).</td></tr>
    <tr><td><code>OMOYA_SKILLS_DIR</code></td><td>Delimiter-separated extra skill roots, scanned after the package and settings layers.</td></tr>
    <tr><td><code>OMOYA_PROMPTS_DIR</code></td><td>Delimiter-separated extra prompt roots, accumulated the same way.</td></tr>
    <tr><td><code>OMOYA_OS_SANDBOX</code></td><td>Set to <code>none</code> to disable the OS write-sandbox probe — the Agent then forces safe mode. Intended for tests and restricted hosts.</td></tr>
    <tr><td><code>OMOYA_TOOL_WORKER</code></td><td>Internal marker the tool sandbox sets on forked mutating-tool workers.</td></tr>
  </tbody>
</table>`;
}

/** One contract source block, whichever fields the collector lifted out. */
function contractSourceHtml(source, links) {
  const prose = (text) => linkApiReferences(markdownHtml(text), links, "");
  const parts = [`<section class="contract-source"><h4><code>${escapeHtml(source.file)}</code>${source.note ? ` <span class="kind">${escapeHtml(source.note)}</span>` : ""}</h4>`];
  if (source.label) parts.push(`<p class="label">${escapeHtml(source.label)}</p>`);
  if (source.doc) parts.push(prose(source.doc));
  if (source.typedefs) {
    parts.push(source.typedefs.map((td) => `<div class="typedef"><h5><code>typedef ${escapeHtml(td.name)}</code></h5>
      ${td.description ? `<p>${linkApiReferences(escapeHtml(td.description), links, "")}</p>` : ""}
      ${td.properties.length ? `<dl class="params">${td.properties.map((p) => `<dt><code>${escapeHtml(p.name)}</code> <span class="type">${escapeHtml(p.type)}</span></dt><dd>${linkApiReferences(escapeHtml(p.description), links, "")}</dd>`).join("")}</dl>` : ""}</div>`).join("\n"));
  }
  if (source.symbols) {
    parts.push(`<ul class="compact">${source.symbols.map((s) => `<li><code>${escapeHtml(s.signature ?? s.name)}</code>${s.doc?.description ? ` — ${linkApiReferences(escapeHtml(firstSentence(s.doc.description)), links, "")}` : ""}</li>`).join("")}</ul>`);
  }
  if (source.members) {
    parts.push(`<ul class="compact">${source.members.map((m) => `<li><code>${escapeHtml(m.signature)}</code>${m.doc?.description ? ` — ${linkApiReferences(escapeHtml(firstSentence(m.doc.description)), links, "")}` : ""}</li>`).join("")}</ul>`);
  }
  if (source.objectKeys) {
    parts.push(`<p>${escapeHtml(source.objectKeys.label ?? source.objectKeys.name)}: ${source.objectKeys.keys.map((k) => `<code>${escapeHtml(k)}</code>`).join(" ")}</p>`);
  }
  if (source.table) {
    parts.push(`<table><thead><tr><th>key</th><th>meaning</th></tr></thead><tbody>${source.table.map((r) => `<tr><td><code>${escapeHtml(r.key)}</code></td><td>${escapeHtml(r.meaning)}</td></tr>`).join("")}</tbody></table>`);
  }
  if (source.example) {
    parts.push(`<pre><code>${escapeHtml(source.example)}</code></pre>`);
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** /api/contracts/ — every schema & contract, sources resolved from source files. */
function contractsBody(data, links) {
  const contracts = data.contracts.filter((c) => c.sources);
  return `<p class="eyebrow">COLLECTED FROM SOURCE — NEVER COPIED PROSE</p>
<h1>Schemas &amp; contracts</h1>
<p class="lede">Module docs, <code>@typedef</code> blocks, exported symbols, class members, object keys, and live examples — lifted from the files that own them on every build.</p>
${contracts.map((c) => `<h2 id="${escapeHtml(slugOf(c.name.split(" — ")[0]))}">${escapeHtml(c.name)}</h2>
${c.sources.map((s) => contractSourceHtml(s, links)).join("\n")}`).join("\n")}`;
}

/** /api/tools/ — the auto-detected live tool catalog. */
// Live schemas stay the source of truth; a few tools earn a short static
// companion note about runtime behavior a JSON schema cannot express
// (routing order, environment auto-detection). Keyed by tool name.
const TOOL_NOTES = {
  "web-search": `<p>Each call routes provider web backend → MCP mapping (<code>settings.web.mcp</code>) → package backend. The package backend tries configured SearXNG instances first (auto-detected from <code>SEARXNG_URL</code>/<code>SEARXNG_BASE</code>, or <code>web.search.backends</code>), then aggregates the enabled engines — DuckDuckGo and Mojeek by default, Brave when <code>BRAVE_API_KEY</code> is set, optional Swisscows — with reciprocal-rank fusion, de-duplication, and tracking-parameter removal. Results are bounded, cached briefly, and rate-limited; <code>settings.web.debug</code> prefixes the taken code path.</p>`,
  "web-fetch": `<p>Same provider → MCP → package routing as web-search. The package backend converts HTML to Markdown (using the optional <code>@mozilla/readability</code> when installed — <code>settings.web.readability: false</code> forces the built-in converter), returning text and JSON bodies as-is. Redirects, size, timeouts, caching, and rate limits are all bounded.</p>`,
};
function toolsBody(data, links) {
  const catalog = data.contracts.find((c) => c.tools);
  if (!catalog) return "<h1>Tool catalog</h1><p>No tool catalog was collected.</p>";
  return `<p class="eyebrow">AUTO-DETECTED FROM tools/*.js — LIVE SCHEMAS</p>
<h1>Tool catalog</h1>
<p class="lede">${escapeHtml(catalog.name)}. Harness metadata flags (<code>sandbox</code>, <code>secret</code>, …) are shown here but stripped from the schemas a model ever sees.</p>
${catalog.tools.map((tool) => `<section class="symbol" id="${escapeHtml(tool.name)}">
  <h3><code>${escapeHtml(tool.name)}</code>${tool.flags.map((f) => ` <span class="flag">${escapeHtml(f)}</span>`).join("")}</h3>
  <p><code>${escapeHtml(tool.file)}</code></p>
  ${linkApiReferences(markdownHtml(tool.description), links, "")}
  ${TOOL_NOTES[tool.name] ?? ""}
  ${tool.inputSchema?.properties ? `<details><summary>Input schema</summary><pre><code>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</code></pre></details>` : ""}
</section>`).join("\n")}`;
}

/** /api/settings/ — the live defaults schema from a package-scoped Env.
 * One section per key mirrors the tool catalog: concise discovery metadata is
 * always visible; the full, potentially nested setting schema is opt-in. */
function settingsBody(data, links) {
  const schema = data.contracts.find((c) => c.entries);
  if (!schema) return "<h1>Settings schema</h1><p>No settings schema was collected.</p>";
  return `<p class="eyebrow">AUTO-DETECTED VIA A PACKAGE-SCOPED ENV — LIVE SCHEMAS</p>
<h1>Settings schema</h1>
<p class="lede">${escapeHtml(schema.name)}. Each key is discovered from the loaded environment; expand its schema only when you need its complete default shape.</p>
${schema.entries.map((entry) => `<section class="symbol" id="${escapeHtml(entry.key)}">
  <h3><code>${escapeHtml(entry.key)}</code></h3>
  ${linkApiReferences(markdownHtml(entry.description), links, "")}
  <details><summary>Schema</summary><pre><code>${escapeHtml(JSON.stringify(entry.schema, null, 2))}</code></pre></details>
</section>`).join("\n")}`;
}

/** Sidebar sub-sections for one module page: every export and its members,
 *  mirroring the anchor scheme the page renderer uses (Symbol-member, with
 *  numeric suffixes for repeated get/set-style member names). */
function moduleSections(mod) {
  return mod.exports.map((symbol) => ({
    hash: symbol.name,
    label: symbol.name,
    children: moduleAnchors(symbol).map(({ member, anchor }) => ({ hash: anchor, label: member.name })),
  }));
}

/**
 * Render every API page. Returns [{path, html, search}] where search entries
 * feed the site-wide search index.
 * @param {object} data - collect()'s JSON document
 */
export function apiPages(data) {
  const nav = apiNavLinks(data);
  const links = buildApiLinks(data);
  const pages = [];
  const add = (path, title, description, body, searchText, sections = []) => {
    pages.push({
      path,
      html: page({ title: `${title} — Omoya API`, description, path, body: `<article class="documentation">${body}</article>`, apiNav: nav, apiSections: sections }),
      search: { title, url: path, text: searchText },
    });
  };
  add("/api/", "API reference", `Generated API reference for ${site.title}.`, overviewBody(data),
    `API reference modules ${data.modules.map((m) => m.name).join(" ")} architecture contracts tools settings`);
  add("/api/architecture/", "Architecture", "Omoya module architecture, dependencies, executables, and IO modes.",
    architectureBody(data.architecture),
    `architecture ${data.architecture.layers.map((l) => `${l.name} ${l.file} ${l.publicDependencies.join(" ")}`).join(" ")} executables ${data.architecture.executables.map((e) => e.name).join(" ")} io modes ${data.architecture.connectors.map((c) => c.name).join(" ")}`);
  for (const mod of data.modules) {
    const text = [mod.doc, ...mod.exports.flatMap((e) => [e.name, e.signature, e.doc?.description, ...(e.members ?? []).map((m) => `${m.name} ${m.doc?.description ?? ""}`)])].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 6000);
    add(`/api/${slugOf(mod.name)}/`, `${mod.name} module`, `Omoya ${mod.name} module (${mod.file}) — generated API reference.`,
      modulePageBody(mod, links), text, moduleSections(mod));
  }
  const contracts = data.contracts.filter((c) => c.sources);
  add("/api/contracts/", "Contracts", "Omoya schemas and contracts collected from source.", contractsBody(data, links),
    contracts.map((c) => c.name).join(" "));
  const catalog = data.contracts.find((c) => c.tools);
  add("/api/tools/", "Tool catalog", "Omoya's auto-detected live tool schemas.", toolsBody(data, links),
    `tool catalog ${(catalog?.tools ?? []).map((t) => `${t.name} ${t.description}`).join(" ").slice(0, 4000)}`);
  add("/api/settings/", "Settings schema", "Omoya's auto-detected settings schema.", settingsBody(data, links),
    `settings schema ${(data.contracts.find((c) => c.entries)?.entries ?? []).map((e) => `${e.key} ${e.description}`).join(" ")}`);
  return pages;
}
