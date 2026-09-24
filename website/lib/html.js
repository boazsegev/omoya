/**
 * website/lib/html.js — escaping, the shared page shell (semantic header /
 * nav / main / footer, metadata, canonical, theme + search controls), and
 * small shared fragments. Every page the build emits goes through page().
 */
import { site } from "../site.js";

/** Escape text for HTML element/attribute contexts. */
export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * The theme bootstrap: runs before first paint so a saved or system dark
 * choice never flashes light. `site` defers to `prefers-color-scheme`.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("omoya-theme")||"site";var dark=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=dark?"dark":"light";document.documentElement.dataset.themeChoice=t;}catch(e){}})();`;

/** Relative prefix from a page path back to the site root ("/" → "./", "/api/" → parent ref). */
export function depthPrefix(path) {
  const depth = path.split("/").filter(Boolean).length;
  return depth === 0 ? "./" : Array.from({ length: depth }, () => "..").join("/") + "/";
}

/** Root-relative href ("…/api/") rebased for a page at depthPrefix `prefix`. */
function rebase(prefix, rootRelative) {
  const bare = rootRelative.slice(0, -1); // strip trailing slash for "./x" joins
  return prefix === "./" ? (bare === "" ? "/" : `.${bare}`) : `${prefix.slice(0, -1)}${bare}`;
}

/**
 * Wordmark: the word stays real text (copy/paste, find-in-page, screen
 * readers); its first letter is transparent and overlaid with an inline SVG
 * mark — the logo ring + prompt glyph in currentColor, so it tracks themes.
 */
export function wordmark(word) {
  const rest = escapeHtml(String(word).slice(1));
  return `<span class="wordmark"><span class="wordmark-o"><span class="wordmark-o-text">${escapeHtml(String(word)[0])}</span><svg class="wordmark-mark" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><circle cx="256" cy="256" r="142"/><path d="M218 207 274 256 218 305 M282 305h38" stroke-linecap="round" stroke-linejoin="round"/></svg></span>${rest}</span>`;
}

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/api/", label: "API" },
];

/**
 * The full HTML document for one page.
 * @param {object} options
 * @param {string} options.title - page <title> (escaped)
 * @param {string} options.description - meta description (escaped)
 * @param {string} options.path - canonical clean path, e.g. "/" or "/api/agent/"
 * @param {string} options.body - trusted, already-escaped main content HTML
 * @param {Array<{href: string, label: string}>} [options.apiNav] - API sidebar links
 * @param {Array<{hash: string, label: string, children?: Array<{hash: string, label: string}>}>} [options.apiSections]
 *   - in-page sections listed under the current sidebar entry
 */
export function page({ title, description, path, body, apiNav, apiSections }) {
  const canonical = `${site.origin}${path}`;
  const prefix = depthPrefix(path);
  const nav = NAV_ITEMS.map((item) => {
    const current = item.href === "/" ? path === "/" : path.startsWith(item.href);
    return `<a href="${rebase(prefix, item.href)}"${current ? ' aria-current="page"' : ""}>${item.label}</a>`;
  }).join("");
  const sectionList = (sections) => `<ul class="api-sections">${sections.map((s) =>
    `<li><a href="#${escapeHtml(s.hash)}">${escapeHtml(s.label)}</a>${s.children?.length
      ? `<ul>${s.children.map((c) => `<li><a href="#${escapeHtml(c.hash)}">${escapeHtml(c.label)}</a></li>`).join("")}</ul>`
      : ""}</li>`).join("")}</ul>`;
  const sidebar = apiNav
    ? `<nav class="api-nav" aria-label="API sections"><h2 class="api-nav-title">API sections</h2><ul>${apiNav.map((item) => {
        const current = item.href === path;
        return `<li${current ? ' class="current"' : ""}><a href="${rebase(prefix, item.href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>${current && apiSections?.length ? sectionList(apiSections) : ""}</li>`;
      }).join("")}</ul></nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="color-scheme" content="light dark">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" type="text/plain" title="LLM documentation" href="${site.origin}/llms.txt">
  <link rel="sitemap" type="application/xml" href="${site.origin}/sitemap.xml">
  <link rel="icon" href="${prefix}assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${prefix}assets/style.css">
  <script>${THEME_BOOTSTRAP}</script>
  <script type="module" src="${prefix}assets/app.js"></script>
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="${rebase(prefix, "/")}">${wordmark("omoya")}</a>
    <nav class="site-nav" aria-label="Site">${nav}<a href="${site.repository}">Repository</a></nav>
    <div class="header-controls">
      <search class="site-search">
        <label class="visually-hidden" for="search-input">Search the Omoya site</label>
        <input id="search-input" type="search" placeholder="Search docs…" autocomplete="off" spellcheck="false">
        <div id="search-results" class="search-results" role="listbox" aria-label="Search results" hidden></div>
      </search>
      <fieldset class="theme-control">
        <legend class="visually-hidden">Color theme</legend>
        <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
        <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
        <button type="button" data-theme-choice="site" aria-pressed="false">System</button>
      </fieldset>
    </div>
  </header>
  ${sidebar ? `<div class="with-sidebar">${sidebar}<main id="content">${body}</main></div>` : `<main id="content">${body}</main>`}
  <footer class="site-footer">
    <p>Omoya is an MIT-licensed transparent Bun agent harness. Canonical site: <a href="${site.origin}/">${site.domains.canonical}</a> (also reachable via ${site.domains.vanity.map((d) => escapeHtml(d)).join(", ")}).</p>
    <p>Built from the current source tree. No cookies, no analytics, no external requests.</p>
  </footer>
</body>
</html>
`;
}
