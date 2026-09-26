/**
 * website/lib/not-found.js — the 404 error page, emitted by the build as
 * build/404.html (the flat file static hosts serve for unmatched URLs).
 * Because a 404 page is served at whatever URL was requested, the shell
 * renders it with rootRelative links and assets, and it carries noindex.
 * Not part of `pages`: it is excluded from the sitemap, the search index,
 * and the link gate's id map, so links must never "resolve" to it.
 */
import { escapeHtml, page } from "./html.js";
import { site } from "../site.js";

export function notFoundPage() {
  return page({
    title: `Page not found · ${site.title}`,
    description: "The page you requested does not exist on the Omoya documentation site.",
    path: "/404.html",
    rootRelative: true,
    noindex: true,
    body: `<section class="hero not-found">
  <p class="code" aria-hidden="true">404</p>
  <p class="eyebrow">page not found</p>
  <h1>This path leads <em>nowhere</em>.</h1>
  <p class="lede">The page you requested does not exist — it may have been moved, renamed, or never built. The documentation is always generated from the current source tree.</p>
</section>
<section class="band split" aria-labelledby="lost-heading">
  <div>
    <p class="section-kicker">Where to from here</p>
    <h2 id="lost-heading">Start from a page that exists.</h2>
    <ul class="checks">
      <li><a href="/">Home</a> — the landing page and install instructions.</li>
      <li><a href="/api/">API reference</a> — the generated module documentation.</li>
      <li><a href="${site.repository}">GitHub</a> — the source tree and issue tracker.</li>
      <li>Or type a few words in the search box above — it indexes every page.</li>
    </ul>
  </div>
  <figure class="terminal" aria-label="A 404, annotated">
    <div class="terminal-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="terminal-title">~/project — om</span></div>
    <ol class="terminal-body">
      <li><span class="prompt">$</span> <span class="cmd">${escapeHtml("om --serve --port 9900")}</span><span class="note"># a page that does exist</span></li>
      <li><span class="prompt">$</span> <span class="cmd">${escapeHtml("open " + site.origin)}</span><span class="note"># start at the docs root instead</span></li>
    </ol>
  </figure>
</section>`,
  });
}
