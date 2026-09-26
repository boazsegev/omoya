# Changelog

All notable changes to Omoya are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.2 — Unreleased

- Sanitize untrusted tool output at renderer ingest (`lib/markdown/text-safe.js`): ANSI escape sequences, C0/C1/DEL controls stripped and CR/CRLF normalized per streaming call (sequences split across chunks caught by a look-back buffer), so bash output can't corrupt TUI geometry, write to the real terminal, or litter the web DOM; SGR bold/italic/underline become balanced Markdown markers. Persisted results and `TOOL_DATA` events stay byte-exact.
- Web app: TUI feature parity and a redesigned interface — command palette (Ctrl/⌘+K), shared TUI themes with live previews (persisted to `tui.theme`), endpoint sign-in/out including browser OAuth and redirect paste, one live card per tool call (arguments, output, duration, error state), streaming thinking, agent and session renaming, delegation permission, new-session variants (read-only, unlogged), add-agent with a model, session clear/delete-all, inline context editing, argument autocomplete with hints, and every TUI slash command (unique prefixes resolve).
- Web app: collapsed thinking/tool/system cards preview the theme's `<role>.preview.maxRows` like the TUI (first line, omission marker, live tail while streaming; tool output stays windowed while it streams); Safari/WebKit dialogs (settings, themes, context, sign-in, palette) no longer collapse to their title; rendering keeps flowing when the browser withholds animation frames (hidden tab, occluded window).
- TUI: OAuth login presets in the login menu now run the browser sign-in instead of only inserting the `/endpoint-login` command; fixed `om --list` hanging on provider timeouts (the listing now shares the bounded model refresh and falls back to cached catalogues).
- Endpoints: dynamic (environment-detected) endpoints persist nothing and never survive their environment — detection re-probes behind a shadow map (rotated keys land immediately, removed keys drop the endpoint and clean up stale auth files), in-memory auth merges only, and `lastModel()` excludes secret/dynamic endpoints.
- read tool: `.ignore`/system files are now a relevance signal instead of an access wall — hidden from listings and searches but still readable by name; folder grep gains a size ceiling (`read.grepFileSizeLimit`, default 5 MB) and `binary: true` supports raw-byte greps; plain listings no longer skip unopenable files.
- Kimi provider: extracted attachment text is cached per IO (keyed by endpoint and file hash) instead of re-uploading every attachment on every request — each tool round used to cost two round trips per file.
- Website: restyled with a rewritten home page (serif/mono system fonts, light and warm-dark palettes, annotated command terminal, Safari and narrow-screen fixes) and a generated styled 404 page (root-relative, noindex, excluded from sitemap/search/link checks).
- Web app fixes: the page failed to load `/text-safe.js` (wrong asset path); a run that threw left the agent shown as working; a pending question was lost on reload or agent switch; a stray backdrop click refused a question; Markdown table alignment was blocked by the CSP.
- Other fixes: write/edit content mentioning device files (`/dev/null` and friends) was refused by the traversal scan; read ENOENT errors leaked absolute container paths; the TUI OAuth test spawned a real browser; a question's 5-minute tool-timeout window could extend a call past `toolTimeoutLimit`; dropped the unused `web.toolLines` setting (collapsed previews follow the TUI theme).

## 0.1.1 — 2026-09-25

- Rewrote the README and website homepage for clarity and adoption: bunx-first quickstart, runnable snippets per surface (TUI, `om-agent`/`om-io` JSONL, `omoya/agent` embed, `om --serve`, `om-jobs`, direct tool CLIs), and a four-point "Why Omoya" pitch verified against the codebase.
- Improved tools, documentation, and the TUI/Web apps, plus misc fixes (including invalid model selection across CLI and web).
- Fixed the TUI login wizard overlay at startup.
- Reflected the public GitHub repo; tightened the README; wired fixes for Kimi message ordering and notice selection.
- Added npm `keywords`, a linked README logo, and this changelog (now included in the published package).
- Gates: 1838/1838 tests, website self-test 25/25.

## 0.1.0 — 2026-09-23

- Initial public release: a transparent, composable Bun AI agent harness library with a TUI, JSONL agent/IO CLIs, provider plugins (OpenAI Responses/Codex OAuth, Kimi, Anthropic, Ollama), direct tool CLIs, jobs, project-scoped memory, and enforced filesystem boundaries.
