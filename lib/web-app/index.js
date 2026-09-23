/**
 * lib/web-app/index.js — the web app's implementation barrel. lib/web.js
 * (the public façade) imports the concrete pieces from here; nothing else
 * in the library should. Kept deliberately thin.
 */
export { createWebServer, MAX_WS_PAYLOAD_LENGTH, serve } from "./server.js";
export { AgentSession } from "./session.js";
export { parseClientMessage } from "./protocol.js";
