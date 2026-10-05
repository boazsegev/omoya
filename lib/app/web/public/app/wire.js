/** Socket transport only. Protocol packets are dispatched by the root orchestrator. */
let socket = null;
let retry = 0;
let reconnectTimer = null;
let packetListener = () => {};
let statusListener = () => {};

/** Register the sole inbound packet sink. */
export function onPacket(listener) { packetListener = listener; }
/** Register connection state changes (open, closed, auth-required). */
export function onStatus(listener) { statusListener = listener; }
/** The current transport status; the reserved auth-required value has no UI yet. */
export function status() { return socket?.readyState === WebSocket.OPEN ? "open" : "closed"; }
/** Send one packet. Returns false when the transport is unavailable. */
export function send(packet) {
  if (status() !== "open") return false;
  socket.send(JSON.stringify(packet));
  return true;
}
/** Connect at a path relative to the current page (including a future project prefix). */
export function connect() {
  clearTimeout(reconnectTimer);
  const url = new URL("ws", location.href);
  // `?resume=<id>` (another view sent the browser here) resumes that saved session
  // once: the first socket carries it, then the page URL drops it.
  const resume = new URLSearchParams(location.search).get("resume");
  if (resume) { url.searchParams.set("resume", resume); history.replaceState(null, "", location.pathname + location.hash); }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const current = socket = new WebSocket(url);
  current.addEventListener("open", () => { if (socket !== current) return; retry = 0; statusListener("open"); });
  current.addEventListener("message", (event) => {
    if (socket !== current) return;
    try { packetListener(JSON.parse(event.data)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    statusListener("closed");
    retry++;
    reconnectTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry));
  });
  current.addEventListener("error", () => current.close());
}
/** Force a reconnect; the status callback and packet sink remain registered. */
export function reconnect() { socket?.close(); clearTimeout(reconnectTimer); connect(); }
