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
 * @property {Function} serve - Start the Bun HTTP/WebSocket server.
 * @property {Function} createWebServer - Alias for serve.
 * @property {typeof AgentSession} AgentSession - Per-connection Agent bridge.
 * @property {Function} parseClientMessage - Validate and normalize a client packet.
 * @property {number} MAX_WS_PAYLOAD_LENGTH - Maximum accepted WebSocket frame size.
 */
export class Web {}
Object.assign(Web, {
  serve, createWebServer, AgentSession, parseClientMessage,
  MAX_WS_PAYLOAD_LENGTH,
});
export default Web;
