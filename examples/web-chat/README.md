# Web chat example

Omoya ships a built-in browser chat: a standalone chat SPA served over HTTP
with a WebSocket carrying the same Agent/Env events used everywhere else. The
**server owns the Agent; the browser only renders it** (root README, *Serve it
to a browser*). This is a CLI capability — there is no separate server library
API to import, and this example deliberately adds no code.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.2 and Omoya:

  ```sh
  bun add -g omoya        # or run without installing: bunx omoya ...
  ```

- A configured provider/model for actual chat (`omoya --login` once), or pass
  a local model selector directly, e.g. `--model ollama/gpt-oss:20b`.

## Launch

```sh
om --serve
om --serve --port 9900 --host 127.0.0.1
```

Without a global install:

```sh
bunx omoya --serve
```

Source-checkout variant:

```sh
bun bin/om --serve
```

Then open the printed loopback URL (default host `127.0.0.1`) in a browser.
Pick an endpoint/model from the interface if you did not pass `--model`, and
chat as usual; the page streams the same text/thinking/tool events the TUI
shows.

## Expected behavior

- The server binds to loopback by default and prints its address.
- The browser tab renders the chat SPA; responses stream live.
- Ctrl-C in the terminal stops the server.

## Loopback security — read before exposing the port

The shipped server is intentionally minimal, as the root README states:

- It binds to **loopback by default** and checks the WebSocket's **Origin
  header**.
- It ships **no auth token**: reaching the port means owning the agent — every
  connected browser can drive the model and its tools with the server's
  permissions.
- Keep it off shared networks. If you must expose it, put your own
  authentication layer (reverse proxy with auth, SSH tunnel, etc.) in front of
  it — do not rely on binding to `0.0.0.0` without one.
