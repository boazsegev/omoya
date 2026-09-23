# Omoya website

This folder is the source for the public Omoya website at `omoya.ai`.

Build the deployable static site with:

```sh
bun run build:site
```

The build output is `website/build/`. It is excluded from the npm package by the root `.npmignore` and from Git by this folder's `.gitignore`. Keep this site source in Git; deploy the generated build independently from the package release.

## Source layout

- `build.js` — clean-first builder: wipes `build/`, renders every page, emits the search index, LLM manifests (`llms.txt`, `llms-full.txt`), `robots.txt`, `sitemap.xml`, and copies `static/`
- `site.js` / `site.json` — shared site data (canonical origin, title, vanity domains)
- `lib/home.js` — the landing page body
- `lib/api.js` — per-module API pages plus architecture/contracts/tools/settings, rendered from `collect()` in `test/api-reference.js`; `buildApiLinks()` indexes every documented API point so `linkApiReferences()` can cross-link whole-identifier `code` mentions (scoped, longest-prefix) to their page anchor
- `lib/html.js` — escaping and the shared page shell (nav, theme control, search, metadata)
- `lib/markdown.js` — the small escaping Markdown subset used for docs prose
- `lib/search.js` — the static client-side search index
- `static/assets/` — `style.css` (light + dark palettes) and `app.js` (theme control + browser search + hash-anchor re-scroll after layout), copied verbatim

Verify a build with `bun ai-tools/ai-website-check.js` (static checks: search anchors resolve, search re-scrolls to the hash, API cross-links are emitted, builtins never link).

## LLM documentation

The build automatically generates these deployment-root files from the current source/docs:

- `/llms.txt` — concise documentation directory with canonical links to the site and generated API pages.
- `/llms-full.txt` — one-fetch corpus containing the project README and generated API reference.
- `/robots.txt` and `/sitemap.xml` — crawler discovery for all generated canonical HTML pages.

They are build artifacts, not manually maintained files. The page shell also advertises the LLM directory and sitemap with `<link>` metadata.

## Intended domains

- Canonical: `omoya.ai`
- Vanity redirects: `omoya.dev`, `omoya.io`

Before launch, choose the hosting provider and configure HTTPS plus permanent redirects from each vanity domain to the canonical URL.

## Planned contents

- Product landing page and install instructions
- Documentation and security-contact links
- Privacy/contact pages as needed
