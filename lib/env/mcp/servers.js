/** Env-private MCP registry. Owns config fingerprints, one client per name,
 * lazy connections, era hints and status; never formats tool responses. */
import { childEnv } from "../../util.js";
import { createClient } from "./client.js";
import { createMcpAuth } from "./oauth.js";

/** Validate only the supported stdio/HTTP server configuration shapes. */
function validate(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "expected a server configuration object";
  const command = typeof config.command === "string" && config.command.length > 0;
  const urlField = typeof config.url === "string" && config.url.length > 0;
  if (command === urlField) return "exactly one of command or url is required";
  if (command) {
    if (config.args !== undefined && (!Array.isArray(config.args) ||
      !config.args.every((arg) => typeof arg === "string"))) return "args must be strings";
  } else {
    let url;
    try { url = new URL(config.url); } catch { return "url must be a valid https or loopback http URL"; }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !loopback)) return "url must be https or loopback http (without credentials)";
    if (config.oauth !== undefined && (typeof config.oauth !== "object" || !config.oauth || Array.isArray(config.oauth) ||
      (config.oauth.clientId !== undefined && (typeof config.oauth.clientId !== "string" || !config.oauth.clientId)) ||
      (config.oauth.issuer !== undefined && (typeof config.oauth.issuer !== "string" || !config.oauth.issuer)))) return "oauth must have optional nonempty clientId/issuer strings";
    if (config.oauth?.clientId && !config.oauth.issuer) return "a pre-registered OAuth clientId requires its authorization-server issuer";
    if (config.oauth && Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) return "OAuth and configured Authorization header cannot be combined";
    if (config.headers !== undefined && (typeof config.headers !== "object" ||
      !config.headers || Array.isArray(config.headers) ||
      Object.values(config.headers).some((value) => typeof value !== "string"))) {
      return "headers must map names to strings";
    }
  }
  return null;
}
/** Expand secrets once per connection without including their values in errors. */
function expandHeaders(config, settings) {
  const env = childEnv(settings, config.env);
  return Object.fromEntries(Object.entries(config.headers ?? {}).map(([header, value]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) throw new Error("MCP header name is invalid");
    const expanded = value.replace(/\$\{([^}]+)\}/g, (_, variable) => {
      if (env[variable] === undefined) throw new Error(`MCP header ${header}: environment variable ${variable} is unset`);
      return env[variable];
    });
    if (!/^[\x09\x20-\x7e]*$/.test(expanded)) throw new Error(`MCP header ${header} has an invalid value`);
    return [header, expanded];
  }));
}
function fingerprint(config) {
  return JSON.stringify(config, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
}
function duration(config) { return Number.isFinite(config.timeout) && config.timeout > 0 ? config.timeout : 30_000; }
/** Build an independent registry for one Env; callbacks publish state changes. */
export function createServers(env, onChange) {
  const entries = new Map();
  function status() {
    return { configured: entries.size,
      connected: [...entries].filter(([, entry]) => entry.state === "connected" && !entry.client?.closed)
        .map(([name]) => name),
      ...([...entries].some(([, entry]) => entry.auth?.needsLogin) ? { needsSignIn: [...entries].filter(([, entry]) => entry.auth?.needsLogin).map(([name]) => name) } : {}) };
  }
  function publish() { onChange?.(status()); }
  /** Reconcile live settings, closing any removed or changed client. */
  function refresh() {
    const raw = env.settings.mcp;
    const configured = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    for (const [name, entry] of entries) {
      if (!Object.hasOwn(configured, name) || entry.key !== fingerprint(configured[name])) {
        entry.client?.close();
        entries.delete(name);
      }
    }
    for (const [name, config] of Object.entries(configured)) if (!entries.has(name)) {
      const reason = validate(config);
      const entry = { config, key: fingerprint(config), state: reason ? "invalid" : "idle",
        error: reason, client: null, era: null, timeout: duration(config), auth: null };
      if (!reason && config.url && config.oauth) {
        try { entry.auth = createMcpAuth(env, name, config, publish); }
        catch (error) { entry.state = "invalid"; entry.error = error.message; }
      }
      entries.set(name, entry);
    }
    publish();
  }
  /** Connect lazily, sharing the handshake but not a caller's cancellation. */
  async function connect(name, signal) {
    const entry = entries.get(name);
    if (!entry || entry.state === "invalid") throw new Error(entry?.error ?? `Unknown MCP server ${name}`);
    if (entry.auth?.needsLogin) throw new Error(`MCP ${name} needs sign-in; run om --mcp-login ${name}`);
    if (entry.state === "connected" && !entry.client?.closed) return entry.client;
    if (!entry.pending) {
      entry.state = "connecting";
      publish();
      entry.pending = (async () => {
        try {
          const config = entry.config.url
            ? { ...entry.config, timeout: entry.timeout, headers: expandHeaders(entry.config, env.settings), oauth: entry.auth }
            : { ...entry.config, timeout: entry.timeout, cwd: env.cwd,
              env: childEnv(env.settings, entry.config.env) };
          const client = entry.client && !entry.client.closed ? entry.client : createClient(name, config, entry.era);
          entry.client = client;
          client.onClose((reason) => {
            if (entry.client !== client) return;
            entry.state = "failed";
            entry.error = reason;
            publish();
          });
          await client.connect(signal);
          if (client.closed) throw new Error(entry.error ?? "MCP connection closed");
          entry.era = client.era;
          entry.state = "connected";
          entry.error = null;
          publish();
          return client;
        } catch (error) {
          if (!signal?.aborted) entry.client?.close();
          if (entry.auth?.challenged(error)) {
            entry.state = "needs-sign-in";
            entry.error = null;
          } else {
            entry.state = "failed";
            entry.error = error.message;
          }
          publish();
          throw error;
        } finally { entry.pending = null; }
      })();
    }
    if (!signal) return entry.pending;
    if (signal.aborted) throw signal.reason ?? new Error("MCP call cancelled");
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("MCP call cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      entry.pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  /** Mark a broken HTTP connection failed; a later use creates a fresh probe. */
  function failure(name, client, error, signal) {
    if (!client?.transport.cancelsByClose || !error?.transportFailure || signal?.aborted) return;
    const entry = entries.get(name);
    if (!entry || entry.client !== client) return;
    client.close();
    entry.state = "failed";
    entry.error = error.message;
    publish();
  }
  /** Stop all owned connections; Env may be reused after close. */
  function closeAll() {
    for (const entry of entries.values()) {
      entry.client?.close();
      entry.client = null;
      entry.state = entry.state === "invalid" ? "invalid" : "idle";
    }
    publish();
  }
  async function login(name, options) {
    const entry = entries.get(name);
    if (!entry?.auth) throw new Error(`MCP ${name} has no configured OAuth`);
    const result = await entry.auth.login(options);
    entry.state = "idle"; entry.error = null;
    const previous = entry.client; entry.client = null; previous?.close();
    publish(); return result;
  }
  function paste(input) {
    for (const entry of entries.values()) if (entry.auth?.paste(input)) return true;
    return false;
  }
  function authFailure(name, error) {
    const entry = entries.get(name);
    if (!entry?.auth?.challenged(error)) return false;
    entry.state = "needs-sign-in"; entry.error = null; publish(); return true;
  }
  return { entries, refresh, connect, closeAll, failure, status, login, paste, authFailure,
    timeout: (name) => entries.get(name)?.timeout ?? 30_000 };
}
