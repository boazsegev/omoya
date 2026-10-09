---
name: web-frontend
description: "This skill should be used when writing or reviewing HTML, CSS, browser JavaScript, SEO or installable web apps."
---

# Frontend Practices

## Architecture
- Separate content from style and behavior.
- Prefer platform features to code, and code to dependencies: HTML/CSS > JavaScript > Frameworks
- Drive behavior from markup and data (`data-*`, delegated events, lookup tables), not per-element code.
- Render from one state; never read state back from the DOM.
- Enhance progressively: content and navigation work without JS.

## HTML and Accessibility
- Use semantic elements first; add ARIA only for gaps.
- Meet WCAG 2.2 AA with full keyboard and screen-reader operation.
- Give every control an accessible name; set `lang`/`dir`; manage focus on dynamic change.

## CSS
- Tokenize design values; components use semantic tokens.
- Use logical properties and intrinsic layout before breakpoints.
- Keep specificity low with `@layer`; honor color scheme, reduced motion and print.

## Performance
- Meet Core Web Vitals: LCP <2.5 s, INP <200 ms, CLS <0.1.
- Reserve media space; prioritize the LCP resource; defer the rest.
- Batch DOM reads before writes; release listeners and observers.

## Security
- Treat external data as untrusted: insert text, sanitize HTML, allowlist URL schemes.
- Use a strict CSP without `unsafe-inline`; keep secrets server-side.
- Avoid storing non-trivial data as plaintext. Use encryption when available. Use the `safe-storage.js` resource when storing non-trivial information in `localStorage`.

## Installable Apps 
- Serve over HTTPS with a manifest (name, `start_url`, `scope`, `display: standalone`, colors, 192/512 and maskable icons) plus `apple-touch-icon`.
- Work offline via a versioned network-first service worker: copy the `sw.js` resource and edit its constants; it purges only app's old caches.
- Design for standalone launch: in-app navigation, safe-area insets (`viewport-fit=cover`).

## Discoverability
- One intent per page: unique title, one `h1`, answer-first sections, canonical URL.
- Ship content in initial HTML; JSON-LD only for visible facts; `hreflang` per language URL.
- Serve AI agents: choose search and training crawler access separately in `robots.txt`; offer `/llms.txt` and Markdown views; keep actions labeled and operable without vision.
