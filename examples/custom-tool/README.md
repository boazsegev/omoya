# Custom tool example

`word-count.js` is a complete, harmless Omoya custom tool module. It follows
the same module contract as the built-in tools: an exported
`toolDescription(env)` returning an MCP-like `{ description, inputSchema }`
per tool name, plus an exported callable of the same name. The `wordCount`
function counts characters, words, and lines — no filesystem, network, or
process access — and the schema marks it `safe: true` so it is also available
in `--safe` mode.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.2 and Omoya (package install or source checkout).
- No provider or model is needed to inspect or invoke the tool directly with
  `om-tool`. An agent-driven run additionally needs a configured endpoint.

## Placement — trusted tool roots only

Omoya scans tool roots for top-level `.js` modules. The user-facing trusted
roots (documented in the root README's *Settings* and *Filesystem security*
sections) are:

1. The **user settings folder's `tools/` subfolder** —
   `~/.omoya-settings/tools/` by default (override the base with the
   `OMOYA_SETTINGS_DIR` environment variable). Copy the module there:

   ```sh
   mkdir -p ~/.omoya-settings/tools
   cp examples/custom-tool/word-count.js ~/.omoya-settings/tools/
   ```

2. A **`tools` key in user settings** (`~/.omoya-settings/settings.json`),
   naming an additional root folder of your choice:

   ```json
   {
     "tools": ["~/my-omoya-tools"]
   }
   ```

   Copy `word-count.js` into that folder instead.

The **project folder is never a tool root** — tool code is executable trust,
so project-writable folders (including `ai-settings.json` in a project) cannot
register executable tools. Do not try to load tools from a project's own
settings; use one of the two roots above.

## Verify and invoke

Confirm the tool is published:

```sh
bunx om-tool --list
```

Invoke it directly, without starting an agent:

```sh
bunx om-tool wordCount '{"text":"hello omoya\nhello world"}'
```

Expected output is the JSON result `{ "characters": 23, "words": 4, "lines": 2 }`
(on the documented result channel; diagnostics stay on stderr).

Then use it from any agent surface — the TUI (`om`), the headless CLI
(`om-agent`), or the browser chat (`om --serve`) — and ask the model to count
words in some text. After editing the module, reload it from the TUI with the
tool-refresh action (or restart the process); the scan re-imports changed
modules on refresh.

Source-checkout variant: replace `bunx om-tool` with `bun bin/om-tool` run
from the checkout root.

## Gotchas

- Only a tool root's **top-level** `.js` files are scanned; subfolders are
  private to a tool's own helpers.
- Keep modules side-effect free: the scan imports them into the host process,
  so top-level printing or long-running work is a bug, not a feature.
- Filenames containing tokens like `test`, `spec`, `example`, or `demo` are
  skipped by the scan — name the file after the tool (e.g. `word-count.js`).
