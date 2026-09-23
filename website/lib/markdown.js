/**
 * website/lib/markdown.js — tiny, dependency-free Markdown subset → HTML
 * for the Omoya site build. Escapes ALL source text first, then applies
 * inline formatting (code spans, emphasis, links) to the escaped text, so
 * no raw HTML from source can ever reach the output. Supports headings
 * (with stable slugs), paragraphs, unordered/ordered lists, fenced code
 * blocks, tables, blockquotes, and horizontal rules. This is deliberately
 * a subset — good enough for docs, not a CommonMark implementation.
 */
import { escapeHtml } from "./html.js";

/** URL-safe slug for a heading, unique within one render pass. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/<[^>]*>/g, "")
      .replace(/&[a-z#0-9]+;/gi, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** Inline formatting on already-escaped text: `code`, **strong**, *em*, [text](url). */
export function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_m, label, url) => {
      const safe = /^https?:\/\//.test(url) || url.startsWith("/") || url.startsWith("#") || url.startsWith("./") || url.startsWith("../");
      return safe ? `<a href="${url}">${label}</a>` : label;
    });
}

/** A table block (consecutive `|` lines) → <table>, or null when not a table. */
function tableHtml(lines) {
  const rows = lines.map((line) => line.split("|").slice(1, -1).map((c) => c.trim()));
  const body = rows.filter((cells) => cells.length > 0 && !cells.every((c) => /^[-: ]*$/.test(c)));
  if (body.length === 0) return null;
  const [head, ...rest] = body;
  const headHtml = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = rest.length === 0 ? ""
    : `<tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${headHtml}${bodyHtml}</table>`;
}

/**
 * Render a Markdown subset to HTML.
 * @param {string} markdown - untrusted source text (escaped before use)
 * @returns {string} HTML
 */
export function markdownHtml(markdown) {
  const slug = slugger();
  const lines = String(markdown).replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(escapeHtml(lines[i])); i++; }
      i++;
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    if (line.startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].startsWith("|")) { block.push(lines[i]); i++; }
      const table = tableHtml(block);
      if (table) { out.push(table); continue; }
      out.push(...block.map((l) => `<p>${inline(l)}</p>`));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = inline(heading[2]);
      out.push(`<h${level} id="${slug(heading[2])}">${text}</h${level}>`);
      i++;
      continue;
    }
    if (/^(?:[-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\d/.test(line);
      const items = [];
      while (i < lines.length && /^(?:[-*]|\d+[.)])\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^(?:[-*]|\d+[.)])\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith("> ")) { quote.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join("")}</blockquote>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.trim() !== "") {
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "" && !/^(#|```|\||[-*] |\d+[.)] |> )/.test(lines[i + 1])) {
        para.push(lines[++i]);
      }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    i++;
  }
  return out.join("\n");
}
