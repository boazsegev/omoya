/** HTTP host: bind, route, validate origins, serve assets. */
import { hostAllowed, loopbackHost, loopbackPeer } from "./hosts.js";
export const MAX_WS_PAYLOAD_LENGTH = 2 * 1024 * 1024;

// Client files under ./public are served by path; the pattern admits no "..",
// hidden files or other extensions. A few modules the SPA shares with sibling
// App areas are served from their owning folder (one source of truth with the TUI).
const shared = {
  "/markdown/browser.js": "../../markdown/browser.js",
  "/markdown/math.js": "../../markdown/math.js",
  "/markdown/inline.js": "../../markdown/inline.js",
  // The Markdown display sanitizer, so web and terminal sanitize identically.
  "/text-safe.js": "../../markdown/text-safe.js",
  // Presentation text shared with the TUI (tool summaries, durations, quotas).
  "/format.js": "../../shared/format.js",
};
const types = { js: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", html: "text/html; charset=utf-8", svg: "image/svg+xml" };
/** @returns {[string, string]|null} public-relative file and content type for a request path. */
function assetFor(pathname) {
  const path = pathname === "/" ? "/index.html" : pathname;
  const match = /^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(js|css|html|svg)$/i.exec(path);
  return match ? [shared[path] ?? path.slice(1), types[match[1].toLowerCase()]] : null;
}
const headers = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
// Inline images: capability key, message, block, content version. Bytes are
// immutable per URL; the sandbox CSP keeps an opened SVG script-free and
// CORP refuses embedding by other sites.
const MEDIA_PATH = /^\/media\/([0-9a-f]{48})\/(\d{1,9})\/(\d{1,9})\/([0-9a-f]{1,16})$/;
const mediaHeaders = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "private, max-age=86400, immutable",
};

/** Decode one URL path segment; malformed escapes and encoded slashes stay as written (segment counts never change). */
const segment = (text) => { try { const decoded = decodeURIComponent(text); return decoded.includes("/") ? text : decoded; } catch { return text; } };
/** A path with every segment decoded (`/group%3Ax/` and `/group:x/` compare equal). */
const decodedPath = (path) => path.split("/").map(segment).join("/");

/**
 * Resolve the view a request path addresses: a project (longest matching URL
 * prefix), else a served group (`/group:<group>`), else the all-projects view.
 * @param {object} registry - Server registry (`list()`, `entries`, `members(group)`).
 * @param {string} pathname - Request path.
 * @returns {{prefix: string, workspace: object|null, group?: string}|null} the raw path prefix
 *   ("" for the root), the project's workspace (null: multi-project view), and the group; null for a group no served project belongs to.
 */
export function viewRoute(registry, pathname) {
  const decoded = decodedPath(pathname);
  const project = registry.list().map((item) => ({ ...item, prefix: decodedPath(item.url.slice(0, -1)) }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find(({ prefix }) => decoded === prefix || decoded.startsWith(`${prefix}/`));
  // Raw prefix: as many raw segments as the decoded prefix has.
  const rawPrefix = (decodedPrefix) => pathname.split("/").slice(0, decodedPrefix.split("/").length).join("/");
  if (project) return { prefix: rawPrefix(project.prefix), workspace: registry.entries.find((entry) => entry.path === project.path).workspace };
  const first = pathname.split("/")[1] ?? "";
  const match = /^group:(.+)$/s.exec(segment(first));
  if (!match) return { prefix: "", workspace: null };
  if (!registry.members(match[1]).length) return null;
  return { prefix: `/${first}`, workspace: null, group: match[1] };
}

export function startWebHost(registry, state = {}) {
  const host = state.host ?? "127.0.0.1";
  let server;
  let port = Number(state.port ?? 9900);
  for (;;) {
    try {
      server = Bun.serve({
    hostname: host,
    port,
    /** Serve WebSocket upgrades, uploads, and public static assets.
     * @param {Request} request - Incoming HTTP request.
     * @param {object} bunServer - Bun server used for WebSocket upgrades.
     * @returns {Promise<Response|undefined>} HTTP response, or undefined after a successful upgrade.
     * @throws {Error} Asset-read failures propagate to Bun's request handler.
     */
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      // DNS rebinding: refuse every request addressed to a foreign name.
      if (!hostAllowed(url, bunServer.port, host)) return new Response("forbidden", { status: 403, headers });
      const origin = `http://${url.host}`;
      // Registered project prefixes serve one project; `/group:<group>/` a group's
      // projects (a project URL wins); every other path is the all-projects view.
      // Multi-project views' sockets, uploads, and media are routed by the registry.
      const route = viewRoute(registry, url.pathname);
      if (!route) return new Response("unknown group", { status: 404, headers });
      const { prefix, workspace, group } = route;
      if (prefix && url.pathname === prefix) return new Response(null, { status: 301, headers: { ...headers, Location: `${prefix}/${url.search}` } });
      const pathname = url.pathname.slice(prefix.length);
      if (pathname === "/ws") {
        if (request.headers.get("origin") !== origin) return new Response("forbidden", { status: 403 });
        // `resume`: a saved session to view first (`?resume=<id>`, set when another view sends the browser here).
        const resume = url.searchParams.get("resume") || undefined;
        return bunServer.upgrade(request, { data: { workspace, multi: !workspace, group, resume, local: loopbackPeer(bunServer.requestIP(request)) && loopbackHost(url) } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (pathname === "/upload") {
        if (request.method !== "POST" || request.headers.get("origin") !== origin) return new Response("forbidden", { status: 403, headers });
        try {
          const key = request.headers.get("x-omoya-upload");
          const form = await request.formData();
          const file = form.get("file");
          const upload = (workspace ?? registry).upload(key, file);
          return Response.json(upload, { headers });
        } catch (error) { return Response.json({ error: error?.message ?? "upload failed" }, { status: 400, headers }); }
      }
      const mediaPath = MEDIA_PATH.exec(pathname);
      if (mediaPath && request.method === "GET") {
        const image = (workspace ?? registry).media(mediaPath[1], Number(mediaPath[2]), Number(mediaPath[3]), mediaPath[4]);
        return image ? new Response(image.bytes, { headers: { ...mediaHeaders, "Content-Type": image.mime } }) : new Response("not found", { status: 404, headers });
      }
      const asset = assetFor(pathname);
      if (!asset || request.method !== "GET") return new Response("not found", { status: 404, headers });
      if (pathname === "/themes.css") return new Response((workspace ?? registry.entries[0].workspace).themeCss(), { headers: { ...headers, "Content-Type": asset[1] } });
      const file = Bun.file(new URL(`./public/${asset[0]}`, import.meta.url));
      if (!await file.exists()) return new Response("not found", { status: 404, headers });
      return new Response(await file.text(), { headers: { ...headers, "Content-Type": asset[1] } });
    },
    websocket: {
      maxPayloadLength: MAX_WS_PAYLOAD_LENGTH,
      open: (ws) => ws.data.multi ? registry.open(ws) : ws.data.workspace.open(ws, { resume: ws.data.resume }),
      message: (ws, data) => ws.data.workspace.message(ws, data),
      close: (ws) => ws.data.workspace.close(ws),
    },
  });
      break;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || port >= 9999) throw error;
      port++;
    }
  }

  const url = `http://${host}:${server.port}/`;
  let resolveDone;
  // Capture the resolver used by stop() to signal server completion.
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let stopped = false;
  /** Stop the server, detach listeners, dispose bridges, and settle `done` once.
   * @returns {void}
   */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const { workspace, env, owned } of registry.entries) { workspace.stop(); if (owned) env.close(); }
    server.stop(true);
    resolveDone();
  };
  return { server, host, port: server.port, url, stop, done };
}
