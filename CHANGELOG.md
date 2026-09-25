# Changelog

All notable changes to Omoya are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.2 — Unreleased

- New changes go here as they land, and this heading gets a release date when 0.1.2 ships.

## 0.1.1 — 2026-09-25

- Rewrote the README and website homepage for clarity and adoption: bunx-first quickstart, runnable snippets per surface (TUI, `om-agent`/`om-io` JSONL, `omoya/agent` embed, `om --serve`, `om-jobs`, direct tool CLIs), and a four-point "Why Omoya" pitch verified against the codebase.
- Improved tools, documentation, and the TUI/Web apps, plus misc fixes (including invalid model selection across CLI and web).
- Fixed the TUI login wizard overlay at startup.
- Reflected the public GitHub repo; tightened the README; wired fixes for Kimi message ordering and notice selection.
- Added npm `keywords`, a linked README logo, and this changelog (now included in the published package).
- Gates: 1838/1838 tests, website self-test 25/25.

## 0.1.0 — 2026-09-23

- Initial public release: a transparent, composable Bun AI agent harness library with a TUI, JSONL agent/IO CLIs, provider plugins (OpenAI Responses/Codex OAuth, Kimi, Anthropic, Ollama), direct tool CLIs, jobs, project-scoped memory, and enforced filesystem boundaries.
