/**
 * TUI application composition. This module accepts normalized launch state;
 * argument syntax, help text, and process exit policy belong to executables.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import Env from "../env.js";
import Agent from "../agent.js";
import CLI from "../cli.js";
import { createInteractiveRepl } from "./run.js";
import { createLineRepl } from "./line-repl.js";

Env._loadThemes = true;
const { SessionStore } = Agent;

export const IO_MODES = Object.freeze(["inline", "alt", "line"]);

export function resolveIoMode(requested, { interactive = true } = {}) {
  const name = requested ?? (interactive ? "alt" : "line");
  if (!IO_MODES.includes(name)) throw new Error(`unknown io mode "${name}" (available: ${IO_MODES.join(", ")})`);
  return name;
}

function resolveSession(session, cwd) {
  if (session?.kind === "anonymous") return { session: undefined };
  if (session?.kind === "resume") {
    const id = session.id === "latest" ? SessionStore.latest({ cwd }) : session.id;
    if (!id) throw new Error("no sessions of this folder to resume");
    return { session: id };
  }
  return { session: session?.id ?? randomUUID() };
}

function inputStream(input, inputFile) {
  if (!inputFile) return input;
  const stream = new PassThrough();
  stream.end(readFileSync(inputFile));
  return stream;
}

/**
 * Run the TUI from normalized application state.
 * @param {Object} state
 * @param {{endpoint?: string, model?: string, url?: string, token?: string}} [state.model]
 * @param {{kind: "new"|"resume"|"anonymous", id?: string}} [state.session]
 * @param {"inline"|"alt"|"line"} [state.mode]
 * @param {object} [state.tools]
 * @param {object} [state.limits]
 * @param {boolean} [state.safe]
 * @param {NodeJS.ReadableStream} [state.input]
 * @param {NodeJS.WritableStream} [state.output]
 * @param {NodeJS.WritableStream} [state.diagnostics]
 * @param {string} [state.inputFile]
 * @param {object} [state.signals]
 * @param {object} [state.env] - injectable, ready environment (tests/embedders)
 * @param {object} [state.envOptions] - forwarded to Env.create when state.env is absent
 * @returns {Promise<{code: number, agent: object, session: object|null}>}
 */
export async function runApplication(state = {}) {
  const input = state.input ?? process.stdin;
  const output = state.output ?? process.stdout;
  const diagnostics = state.diagnostics ?? process.stderr;
  const log = (line) => diagnostics.write(`${line}\n`);
  if (state.session?.kind === "resume" && state.session.id !== "latest") {
    CLI.adoptResumeOrigin({ resume: state.session.id, anonymous: false });
  }
  const env = state.env ?? await Env.create(state.envOptions);
  env.refreshModels().catch(() => {});

  const selection = await CLI.selectEndpointModel(env, state.model ?? {}, { lastUsed: true, log });
  const interactive = state.interactive ?? (input.isTTY === true || Boolean(state.inputFile));
  const mode = resolveIoMode(state.mode, { interactive });
  const session = resolveSession(state.session, env.cwd);
  const agent = new Agent({
    env,
    ...(selection.endpoint && selection.model ? { model: `${selection.endpoint}/${selection.model}` } : {}),
    url: state.model?.url,
    timeout: state.timeout,
    settings: state.model?.token ? { auth: { token: state.model.token } } : undefined,
    tools: state.tools?.names,
    safe: state.safe === true,
    maxTurns: state.limits?.maxTurns,
    maxToolCalls: state.limits?.maxToolCalls,
    toolCall: state.tools?.call,
    ...(session.session === undefined ? {} : { session: session.session }),
  });
  if (!interactive || !diagnostics.isTTY) agent.onEvent(Agent.EVENT.LOG, log);
  CLI.writeLastCombo(env, { endpoint: selection.endpoint, model: agent.model });
  log(agent.session ? `session: ${agent.session.id} — ${agent.session.file}` : "session: anonymous (not persisted)");

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

  if (activeAgent.session) CLI.writeLastCombo(env, { endpoint: activeAgent.endpoint, model: activeAgent.model });
  return { code: CLI.EXIT.ok, agent: activeAgent, session: activeAgent.session ?? null };
}
