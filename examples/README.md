# Omoya examples

Small, self-contained examples that follow the **public library API and CLI**
documented in the repository's root [`README.md`](../README.md) — nothing here
uses private internals. Each folder has its own README with prerequisites,
commands, and expected behavior.

> These examples ship with the repository for reading on GitHub. They are
> **not** part of the published npm package (the root `.npmignore` uses a
> deny-all allowlist that does not include `examples/`).

All examples require [Bun](https://bun.sh/) (≥ 1.2) and favor a package
installation workflow (`bun add omoya`, `bunx omoya ...`); running from a
source checkout is noted as a short variant where relevant.

| Example | Purpose | Requirements |
|---|---|---|
| [`headless-agent/`](headless-agent/) | Embed the library: build an `Agent` over `Agent.Env.create()`, enqueue a user message, and stream `Agent.EVENT` lifecycle events from a Bun ESM script. | Bun, `bun add omoya`, and a **configured provider/model** (see its README). Reading the script is safe; running it without a provider fails fast with a clear message. |
| [`custom-tool/`](custom-tool/) | Author a custom tool module — a documented `toolDescription()` plus a harmless `wordCount` function — and load it through Omoya's trusted tool roots. | Bun and Omoya (package install or source checkout). No provider needed to inspect the tool with `om-tool`. |
| [`web-chat/`](web-chat/) | Launch Omoya's built-in browser chat SPA with the documented `om --serve` CLI command, with loopback security notes. | Bun, Omoya, and a configured provider/model for actual chat. |

## Notes

- Examples contain no credentials and make no live network calls until you run
  them against a provider you have configured yourself.
- Model selectors like `ollama/gpt-oss:20b` are **illustrative**; substitute an
  endpoint/model pair your own Omoya installation actually has. Run
  `omoya --login` (or `bunx omoya --login`) to configure one.
- Every example treats the **current working folder as the agent's root**, the
  same policy documented in the root README's security section.
