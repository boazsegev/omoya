/**
 * TUI application composition. This module accepts normalized launch state;
 * argument syntax, help text, and process exit policy belong to executables.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import Env from "../../env.js";
import Agent from "../../agent.js";
import CLI from "../cli.js";
import { createInteractiveRepl } from "./run.js";
import { createLineRepl } from "./line-repl.js";

/** Supported terminal I/O modes for the TUI. */
export const IO_MODES = Object.freeze(["inline", "alt", "line"]);

/**
 * Resolve and validate the requested terminal I/O mode.
 * @param {"inline"|"alt"|"line"|null|undefined} requested - Requested mode; when omitted, choose from `interactive` and `alt`.
 * @param {{interactive?: boolean, alt?: boolean}} [options={}] - Mode selection options; `interactive` defaults to `true`; `alt` (settings tui.alt) defaults to `true`, and `false` selects inline for an interactive terminal.
 * @returns {"inline"|"alt"|"line"} The validated mode (unspecified: `line` when not interactive, else `alt` unless `alt` is false).
 * @throws {Error} If the selected mode is not in {@link IO_MODES}.
 */
export function resolveIoMode(requested, { interactive = true, alt = true } = {}) {
  const name = requested ?? (!interactive ? "line" : alt === false ? "inline" : "alt");
  if (!IO_MODES.includes(name)) throw new Error(`unknown io mode "${name}" (available: ${IO_MODES.join(", ")})`);
  return name;
}

/**
 * Determine the agent context identifier for a requested session.
 * @param {{kind?: string, id?: string}|null|undefined} session - Session selection; anonymous disables context, resume resolves an ID or latest session, and other kinds use the ID or a new UUID.
 * @param {object} env - Environment providing session settings and working directory for latest-session lookup.
 * @returns {Promise<{contextId: string|false}>} Context ID, or `false` for anonymous sessions.
 * @throws {Error} If a resume request cannot resolve a session.
 */
async function resolveSession(session, env) {
  if (session?.kind === "anonymous") return { contextId: false };
  if (session?.kind === "resume") {
    const id = session.id === "latest" ? (await Agent.Context.listAsync({ dir: env.settings.sessions, cwd: env.folder, limit: 1 }))[0]?.id : session.id;
    if (!id) throw new Error("no sessions of this folder to resume");
    return { contextId: id };
  }
  return { contextId: session?.id ?? randomUUID() };
}

/**
 * Use the supplied input stream or create a stream containing an input file's bytes.
 * @param {NodeJS.ReadableStream} input - Fallback input stream.
 * @param {string|null|undefined} inputFile - Optional file path; when present, its contents replace the input stream.
 * @returns {NodeJS.ReadableStream} The original stream or a `PassThrough` containing the file contents.
 * @throws {Error} If the requested file cannot be read synchronously.
 */
function inputStream(input, inputFile) {
  if (!inputFile) return input;
  const stream = new PassThrough();
  stream.end(readFileSync(inputFile));
  return stream;
}

/**
 * Run the TUI from normalized application state.
 * @param {Object} [state={}] - Normalized application launch state.
 * @param {{endpoint?: string, model?: string, url?: string, token?: string}} [state.model] - Endpoint/model selection and optional URL or authentication token.
 * @param {{kind: "new"|"resume"|"anonymous", id?: string}} [state.session] - Session creation, resumption, or anonymous-context selection.
 * @param {"inline"|"alt"|"line"} [state.mode] - TUI I/O mode; defaults according to interactivity.
 * @param {{names?: string[], call?: {fork?: boolean, timeout?: number}}} [state.tools] - Tool names and supported Agent tool-call policy.
 * @param {{write?: boolean}} [state.can] - Agent write capability; `false` selects read-only mode.
 * @param {NodeJS.ReadableStream} [state.input] - Input stream; defaults to `process.stdin`.
 * @param {NodeJS.WritableStream} [state.output] - TUI output stream; defaults to `process.stdout`.
 * @param {NodeJS.WritableStream} [state.diagnostics] - Diagnostic/log stream; defaults to `process.stderr`.
 * @param {string} [state.inputFile] - Optional file whose contents provide REPL input.
 * @param {object} [state.signals] - Signal controls forwarded to the interactive REPL.
 * @param {object} [state.env] - Injectable, ready environment (tests/embedders); takes precedence over `envOptions`.
 * @param {object} [state.envOptions] - Explicit embedding options forwarded to `Env.open` when `state.env` is absent.
 * @returns {Promise<{code: number, agent: object, session: object|null}>}
 */
export async function runApplication(state = {}) {
  const input = state.input ?? process.stdin;
  const output = state.output ?? process.stdout;
  const diagnostics = state.diagnostics ?? process.stderr;
  const log = (line) => diagnostics.write(`${line}\n`);
  if (state.session?.kind === "resume" && state.session.id !== "latest") {
    await CLI.adoptResumeOrigin({ resume: state.session.id, anonymous: false });
  }
  const { cwd = process.cwd(), ...envOptions } = state.envOptions ?? {};
  const hasOverride = state.model?.url !== undefined || state.model?.token !== undefined || state.timeout !== undefined;
  const endpoint = hasOverride && typeof state.model?.model === "string" ? state.model.model.split("/")[0] : undefined;
  if (hasOverride && (!endpoint || !state.model.model.includes("/") || ["__proto__", "constructor", "prototype"].includes(endpoint))) {
    throw new TypeError("provider URL, token, and timeout require a qualified endpoint/model selector");
  }
  if (hasOverride && state.env !== undefined) throw new TypeError("provider overrides require an owned Env; pass envOptions instead of env");
  // Inspect existing endpoint identity before layering invocation-only settings.
  // This temporary embedding never writes provider configuration to disk.
  let provider;
  if (hasOverride) {
    const probe = await Env.open(cwd, { ...envOptions, init: { providers: false, tools: false, detect: false, models: false } });
    try {
      const known = probe.settings.providers?.[endpoint];
      provider = known?.provider ?? (known?.url ? "openai" : undefined);
    } finally { await probe.close(); }
    if (!provider && state.model.url === undefined) throw new TypeError(`unknown endpoint "${endpoint}": URL required for provider overrides`);
    // A new URL names its protocol explicitly; existing endpoint identities
    // retain their configured protocol even if the endpoint name differs.
    provider ??= endpoint;
  }
  const overrides = hasOverride ? { ...envOptions.settings, providers: {
    ...envOptions.settings?.providers, [endpoint]: {
      ...envOptions.settings?.providers?.[endpoint],
      ...(state.model.url === undefined ? {} : { provider, url: state.model.url }),
      ...(state.model.token === undefined ? {} : { auth: { ...envOptions.settings?.providers?.[endpoint]?.auth, token: state.model.token } }),
      ...(state.timeout === undefined ? {} : { timeout: state.timeout }),
    },
  } } : undefined;
  const owned = state.env === undefined && (hasOverride || state.envOptions !== undefined || Env.envs[cwd] === undefined);
  const env = state.env ?? await Env.open(cwd, hasOverride ? { ...envOptions, settings: overrides } : state.envOptions === undefined ? undefined : envOptions);
  try {
  const selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  const interactive = state.interactive ?? (input.isTTY === true || Boolean(state.inputFile));
  const mode = resolveIoMode(state.mode, { interactive, alt: env.settings?.tui?.alt });
  const session = await resolveSession(state.session, env);
  const agent = await Agent.create({
    env,
    ...(selection ? { model: selection } : {}),
    tools: state.tools?.names,
    can: { write: state.can?.write !== false },
    toolCall: state.tools?.call,
    ...(session.contextId === undefined ? {} : { contextId: session.contextId }),
  });
  if (!interactive || !diagnostics.isTTY) agent.onEvent(Agent.EVENT.LOG, log);
  log(`session: ${agent.context.summary}`);

  const source = inputStream(input, state.inputFile);
  let activeAgent = agent;
  if (mode === "line") {
    const repl = createLineRepl({ agent, input: source, writeOut: (chunk) => output.write(chunk), log,
      ansi: output.isTTY === true });
    await repl.run();
  } else {
    const repl = createInteractiveRepl({ agent, env, mode, input: source, output,
      log: diagnostics.isTTY ? undefined : log, signals: state.signals,
      onExit: ({ agent: current }) => { activeAgent = current; } });
    await repl.start();
    if (state.inputFile) diagnostics.write("\n");
  }

  return { code: CLI.EXIT.ok, agent: activeAgent, session: activeAgent.context };
  } finally { if (owned) await env.close(); }
}
