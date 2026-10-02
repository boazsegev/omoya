/**
 * lib/app/web/index.js — App.Web: the browser chat SPA front end.
 *
 * It uses only the public Agent, Env, CLI, and Context APIs; it has no TUI
 * or GTUI dependency. `serve(state)` starts Bun's HTTP static-file server
 * and WebSocket endpoint; each connection is backed by an AgentSession,
 * while the browser owns only presentation. The server enforces
 * loopback-by-default binding, same-host Origin checks, a 2 MiB WebSocket
 * frame limit, and a strict CSP; it uses no URL authentication token.
 *
 * Consumed by the `om --serve` application entry point. See server.js for
 * the launch-state contract.
 */

import { createWebServer, MAX_WS_PAYLOAD_LENGTH, serve } from "./server.js";
import { AgentSession } from "./session.js";
import { parseClientMessage } from "./protocol.js";

/**
 * Static namespace for the Web front end (published as App.Web by lib/app.js).
 * @property {typeof serve} serve - Start the Bun HTTP/WebSocket server. Accepts the optional launch-state object described by `server.js` and returns the server lifecycle Promise.
 * @property {typeof createWebServer} createWebServer - Alias for `serve`, with the same arguments, Promise result, and effects/errors.
 * @property {typeof AgentSession} AgentSession - Per-connection Agent bridge class; see `session.js` for its constructor parameters and behavior.
 * @property {typeof parseClientMessage} parseClientMessage - Validate and normalize a client packet; see `protocol.js` for accepted inputs and errors.
 * @property {typeof MAX_WS_PAYLOAD_LENGTH} MAX_WS_PAYLOAD_LENGTH - Maximum accepted WebSocket frame size, in bytes (2 MiB).
 */
export class Web {}
Object.assign(Web, {
  serve, createWebServer, AgentSession, parseClientMessage,
  MAX_WS_PAYLOAD_LENGTH,
});
export default Web;
