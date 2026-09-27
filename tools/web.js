/** Conventional web capabilities with mapped MCP -> package routing. A
 *  provider's own web tool shadows these by name (Env.toolCall serves the
 *  pair's provider tool first and falls through here when it declines). */
import { toolRevision, WEB_LIMIT_DEFAULTS, WEB_THROTTLE_DEFAULTS } from "../lib/tool-runtime.js";

const revision = toolRevision();
const { packageSearch } = await import(`./web/search/index.js?now=${revision}`);
const { initializeReadability, packageFetch } = await import(`./web/fetch/index.js?now=${revision}`);

const { webBudgetMs } = await import(`./web/shared.js?now=${revision}`);
const MCP_TIMEOUT = 15_000;

function normalizeSearch(args = {}) {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    throw new TypeError("web-search: query must be a non-empty string");
  }
  const raw = args.limit ?? 40;
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new TypeError("web-search: limit must be a finite integer");
  }
  const absolute = Math.abs(raw);
  return { query: args.query.trim(), limit: absolute === 0 ? 40 : Math.min(absolute, 40), wasClamped: absolute > 40 };
}

function normalizeFetch(args = {}) {
  if (typeof args.url !== "string" || args.url.trim() === "") {
    throw new TypeError("web-fetch: url must be a non-empty string");
  }
  let url;
  try { url = new URL(args.url.trim()); } catch { throw new TypeError("web-fetch: url must be a valid HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== "" || url.password !== "") {
    throw new TypeError("web-fetch: url must be HTTP(S) and contain no credentials");
  }
  return { url: url.href };
}

function deadlineSignal(parent, duration) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error("web request cancelled"));
  if (parent?.aborted) abort();
  else parent?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`web request timed out after ${duration}ms`)), Math.max(0, duration));
  timer.unref?.();
  return {
    signal: controller.signal,
    deadline: Date.now() + duration,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", abort);
    },
  };
}

/** Race an uncooperative backend against the dispatch deadline. */
function awaitWithinSignal(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("web request cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("web request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cleanMcpDetail(value, env) {
  let text = String(value ?? "MCP failure").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  for (const token of configuredTokens(env?.settings?.web)) {
    if (token !== "") text = text.split(token).join("[REDACTED]");
  }
  text = text.replace(/\s+/g, " ").trim();
  return [...text].length > 1000 ? `${[...text].slice(0, 999).join("")}…` : text;
}

function configuredTokens(web) {
  const values = [];
  const add = (item) => { if (typeof item?.token?.value === "string") values.push(item.token.value); };
  for (const item of web?.search?.backends ?? []) add(item);
  for (const item of web?.search?.engines ?? []) add(item);
  return values;
}

function debugEnabled(context) {
  const value = context?.env?.settings?.web?.debug;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError("web.debug must be a boolean");
  return value;
}

function withCodePath(content, path, isDebug) {
  return isDebug ? `HTTP: ${path}\n\n${content}` : content;
}

/**
 * The dispatch-level access-point label, uniform across web-search and
 * web-fetch so debug output always names where the data came from: `mcp`
 * (a configured MCP server tool) or `local` (the bundled package backend —
 * the fallback). Every debug response starts with one of these; the package
 * backends' own internal HTTP access point (SearXNG/engine detail) is
 * appended after, not relied on for the headline.
 */
const ACCESS_LOCAL = "local";

async function dispatch(kind, args, context, packageBackend) {
  const isDebug = debugEnabled(context);
  const total = deadlineSignal(context?.signal, webBudgetMs(context));
  let mcpError;
  try {
    const mapping = context?.env?.settings?.web?.mcp;
    const remoteTool = kind === "search" ? mapping?.searchTool : mapping?.fetchTool;
    const shortcut = typeof mapping?.server === "string" ? `mcp-${mapping.server}` : undefined;
    if (mapping?.shadow === true && remoteTool && (await context?.agent?.toolCallable?.(shortcut)) !== false) {
      try {
        const remaining = Math.max(1, total.deadline - Date.now());
        const content = await awaitWithinSignal(context.env.toolCall("mcp", { action: "call", server: mapping.server, tool: remoteTool, arguments: args, timeout: Math.min(MCP_TIMEOUT, remaining) }, { ...context, signal: total.signal }), total.signal);
        if (typeof content !== "string" || content.trim() === "") throw new Error("MCP web result is empty");
        return withCodePath(content, `mcp (${mapping.server}/${remoteTool})`, isDebug);
      } catch (error) {
        if (total.signal.aborted) throw total.signal.reason;
        mcpError = cleanMcpDetail(error?.mcpDetail ?? error?.message ?? error, context?.env);
      }
    }
    // Uniform access-point label for the local/package fallback. web-search's
    // backend owns an internal HTTP access point line (SearXNG/engine), so it merges the
    // label via accessLabel; web-fetch has none, so it takes a plain prefix.
    const content = await awaitWithinSignal(packageBackend(args, { ...context, signal: total.signal, deadline: total.deadline, accessLabel: isDebug ? ACCESS_LOCAL : undefined }), total.signal);
    if (total.signal.aborted) throw total.signal.reason;
    const labelled = kind === "fetch" ? withCodePath(content, ACCESS_LOCAL, isDebug) : content;
    return mcpError ? `${labelled}\n\nMCP tool was skipped due to the following MCP reported error: ${mcpError}` : labelled;
  } finally {
    total.close();
  }
}

export async function webSearch(args, context) {
  return dispatch("search", normalizeSearch(args), context, packageSearch);
}

export async function webFetch(args, context) {
  return dispatch("fetch", normalizeFetch(args), context, packageFetch);
}

/** This tool's own contribution to env.settingsSchema() — the web
 *  namespace shared by the conventional web-search/web-fetch tools:
 *  `debug` prefixes the taken HTTP access point, `search` holds
 *  backend/engine config, `mcp` the server mapping, and `readability`
 *  the fetch converter toggle. (A provider's own web tool is opted out
 *  through the core `providerTools` setting.) */
export function settingsSchema() {
  return {
    web: {
      default: { limit: WEB_LIMIT_DEFAULTS, throttle: WEB_THROTTLE_DEFAULTS },
      description:
        "Web tools: debug (show the taken HTTP access point), search {backends, engines, " +
        "cache}, fetch {timeout, cacheSeconds, ...}, limit {calls:8, windowMs:40000} " +
        "shared by package fetch/search; throttle {startAt:0.2, step:0.05, stepMs:1000}: " +
        "success pauses capped at half the actual remaining tools.timeout; parallel pauses overlap. " +
        "Full burst waits only below half the remaining deadline, otherwise busy. " +
        "Dispatch respects Agent deadlines or tools.timeout/tools.timeoutLimit defaults. mcp {server, searchTool, fetchTool, " +
        "shadow}, readability.",
    },
  };
}

export function toolDescription(env) {
  const readability = env?.settings?.web?.readability;
  if (readability !== false) initializeReadability();
  return {
    "web-search": {
      fn: webSearch,
      safe: true,
      trusted: true,
      description: "Search the internet and return bounded Markdown results.",
      inputSchema: { type: "object", properties: {
        query: { type: "string", description: "Search query, including any engine syntax" },
        limit: { type: "integer", description: "Result count; default/max 40, zero means 40, negatives use absolute value" },
      }, required: ["query"] },
    },
    "web-fetch": {
      fn: webFetch,
      safe: true,
      trusted: true,
      description: "Fetch one HTTP(S) URL as bounded Markdown, text, or JSON text.",
      inputSchema: { type: "object", properties: {
        url: { type: "string", description: "HTTP(S) URL without embedded credentials" },
      }, required: ["url"] },
    },
  };
}
