# Headless agent example

A Bun ESM script that embeds Omoya's public library API (`omoya/agent`) to run
one agent turn without the terminal UI: it builds an environment with
`Agent.Env.create()`, constructs an `Agent` for an illustrative model
selector, registers `Agent.EVENT` listeners, enqueues a user message, and
awaits the terminal `done`/`error` event from `agent.run()`.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.2.
- Omoya installed as a package dependency:

  ```sh
  bun add omoya
  ```

- A **configured provider and model**. The script ships with the README's
  illustrative local selector `ollama/gpt-oss:20b`. Configure an endpoint once
  with `omoya --login` (interactive) or via your user settings `providers`
  table, then edit `MODEL_SELECTOR` in `agent.js` to an `<endpoint>/<model>`
  pair your installation actually has. With no matching endpoint the script
  exits with a clear message before any network call.

## Run

From the folder containing this example's parent (or any working folder with
`omoya` installed):

```sh
bun examples/headless-agent/agent.js
```

Source-checkout variant: replace the `"omoya/agent"` import with a relative
path to the checkout's `lib/agent.js`, and run from a folder where the
checkout's tools are reachable.

## Expected behavior

- With a reachable endpoint: the assistant's reply streams to stdout
  (`assistant: ...`), tool executions and a usage summary go to stderr, and
  the process exits with code 0.
- With no configured endpoint: a one-line error on stderr, exit code 1.
- The agent runs in `safe: true` mode (read-only tools only) with an anonymous
  in-memory session — nothing is persisted, and the model can only read files
  inside the current working folder, per the README's security policy.

Reading the script without executing it is always safe.
