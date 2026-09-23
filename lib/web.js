/**
 * lib/web.js — the Web front-end façade: a browser chat SPA.
 *
 * The implementation lives in lib/web-app/. It uses only the public Agent,
 * Env, CLI, and Context APIs; it has no TUI, GTUI, or tui-app dependency.
 * `serve(state)` starts Bun's HTTP static-file server and WebSocket endpoint;
 * each connection is backed by an AgentSession, while the browser owns only
 * presentation. The server enforces loopback-by-default binding, same-host
 * Origin checks, a 2 MiB WebSocket frame limit, and a strict CSP; it uses no
 * URL authentication token.
 *
 * This façade is consumed by the `om --serve` application entry point. See
 * lib/web-app/server.js for the launch-state contract.
 */

import { createWebServer, MAX_WS_PAYLOAD_LENGTH, serve } from "./web-app/server.js";
import { AgentSession } from "./web-app/session.js";
import { parseClientMessage } from "./web-app/protocol.js";

/**
 * Static namespace for the Web front end.
 * @property {Function} serve - Start the Bun HTTP/WebSocket server.
 * @property {Function} createWebServer - Alias for serve.
 * @property {typeof AgentSession} AgentSession - Per-connection Agent bridge.
 * @property {Function} parseClientMessage - Validate and normalize a client packet.
 * @property {number} MAX_WS_PAYLOAD_LENGTH - Maximum accepted WebSocket frame size.
 */
export class Web {}
/** Start the Web HTTP/WebSocket server. */
/** Alias for the Web server entry point. */
/** Bridge one browser connection to one Agent. */
/** Parse and validate an untrusted browser packet. */
/** Maximum WebSocket payload accepted by the Web server. */
Object.assign(Web, {
  serve, createWebServer, AgentSession, parseClientMessage,
  MAX_WS_PAYLOAD_LENGTH,
});
export default Web;
