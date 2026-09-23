/**
 * public/markdown.js — a tiny, dependency-free Markdown → safe-HTML
 * renderer for the chat SPA. It renders ONLY through escaped text nodes
 * (no raw HTML injection): input is escaped first, then a small set of
 * block (fences, headings, lists, quotes, paragraphs) and inline (code,
 * bold, italic, links) constructs is recognized. Anything unrecognized
 * stays literal text. This is presentation sugar — the wire carries plain
 * Markdown; the Agent/library never sees HTML.
 */

const escapeHtml = (text) => String(text)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const escapeAttr = (text) => escapeHtml(text).replaceAll("'", "&#39;");

/** Inline: `code`, **bold**, *em*, [text](url). Input is already escaped. */
function inline(escaped) {
  let out = escaped;
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_m, text, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  return out;
}

/** Render Markdown to an HTML string made only of escaped text + our tags. */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null; // "ul" | "ol" | null
  let inFence = false;
  let fenceLang = "";
  let fenceBody = [];

  const cells = (line) => {
    const trimmed = line.trim();
    const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
    const source = body.endsWith("|") ? body.slice(0, -1) : body;
    return source.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
  };
  const alignments = (line, count) => {
    const values = cells(line);
    if (values.length !== count || !values.every((value) => /^:?-{3,}:?$/.test(value))) return null;
    return values.map((value) => value.startsWith(":") && value.endsWith(":") ? "center" : value.startsWith(":") ? "left" : value.endsWith(":") ? "right" : null);
  };
  const table = (header, align, rows) => {
    const cell = (tag, value, index) => `<${tag}${align[index] ? ` style="text-align:${align[index]}"` : ""}>${inline(escapeHtml(value))}</${tag}>`;
    return `<div class="md-table-wrap"><table><thead><tr>${header.map((value, index) => cell("th", value, index)).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`).join("")}</tbody></table></div>`;
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.map(escapeHtml).join("\n")).replaceAll("\n", "<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  const openList = (kind) => {
    if (list === kind) return;
    flushParagraph(); flushList();
    html.push(`<${kind}>`);
    list = kind;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (inFence) {
        html.push(`<pre class="md-code"${fenceLang ? ` data-lang="${escapeAttr(fenceLang)}"` : ""}><code>${escapeHtml(fenceBody.join("\n"))}</code></pre>`);
        inFence = false; fenceLang = ""; fenceBody = [];
      } else {
        flushParagraph(); flushList();
        inFence = true; fenceLang = fenceMatch[1] || ""; fenceBody = [];
      }
      continue;
    }
    if (inFence) { fenceBody.push(line); continue; }

    const header = cells(line);
    const align = line.includes("|") && index + 1 < lines.length ? alignments(lines[index + 1], header.length) : null;
    if (align) {
      flushParagraph(); flushList();
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const row = cells(lines[index]);
        if (row.length !== header.length) break;
        rows.push(row); index++;
      }
      html.push(table(header, align, rows));
      index--;
      continue;
    }

    if (/^\s*$/.test(line)) { flushParagraph(); flushList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      html.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) { openList("ul"); html.push(`<li>${inline(escapeHtml(unordered[1]))}</li>`); continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) { openList("ol"); html.push(`<li>${inline(escapeHtml(ordered[1]))}</li>`); continue; }

    flushList();
    paragraph.push(line);
  }
  if (inFence) html.push(`<pre class="md-code"><code>${escapeHtml(fenceBody.join("\n"))}</code></pre>`);
  flushParagraph(); flushList();
  return html.join("\n");
}
