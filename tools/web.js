/** Conventional web capabilities with provider -> mapped MCP -> package routing. */
import { toolRevision } from "../lib/tool-runtime.js";
import { callMcp } from "./mcp.js";

const revision = toolRevision();
const { packageSearch } = await import(`./web/search/index.js?now=${revision}`);
const { initializeReadability, packageFetch } = await import(`./web/fetch/index.js?now=${revision}`);

const TOTAL_TIMEOUT = 30_000;
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

function deadlineSignal(parent, duration = TOTAL_TIMEOUT) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error("web request cancelled"));
  if (parent?.aborted) abort();
  else parent?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`web request timed out after ${duration}ms`)), duration);
  timer.unref?.();
  return { signal: controller.signal, deadline: Date.now() + duration, close: () => clearTimeout(timer) };
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
  return isDebug ? `Code Path: ${path}\n\n${content}` : content;
}

async function dispatch(kind, args, context, packageBackend) {
  const isDebug = debugEnabled(context);
  const total = deadlineSignal(context?.signal);
  let mcpError;
  try {
    const provider = await context?.agent?.callProviderCapability?.(`web-${kind}`, args, {
      signal: total.signal, deadline: total.deadline,
    });
    if (provider?.status === "success") return withCodePath(provider.content, "provider", isDebug);
    if (total.signal.aborted) throw total.signal.reason;
    const mapping = context?.env?.settings?.web?.mcp;
    const remoteTool = kind === "search" ? mapping?.searchTool : mapping?.fetchTool;
    const shortcut = typeof mapping?.server === "string" ? `mcp-${mapping.server}` : undefined;
    if (mapping?.shadow === true && remoteTool && context?.agent?.canCallTool?.(shortcut) !== false) {
      try {
        const remaining = Math.max(1, total.deadline - Date.now());
        const content = await callMcp({ server: mapping.server, tool: remoteTool, arguments: args, timeout: Math.min(MCP_TIMEOUT, remaining), signal: total.signal }, context);
        return withCodePath(content, `MCP (${mapping.server}/${remoteTool})`, isDebug);
      } catch (error) {
        if (total.signal.aborted) throw total.signal.reason;
        mcpError = cleanMcpDetail(error?.mcpDetail ?? error?.message ?? error, context?.env);
      }
    }
    const content = await packageBackend(args, { ...context, signal: total.signal, deadline: total.deadline });
    return mcpError ? `${content}\n\nMCP tool was skipped due to the following MCP reported error: ${mcpError}` : content;
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

/** This tool's own contribution to env.defaultsSchema() — the web
 *  namespace shared by the conventional web-search/web-fetch tools:
 *  `provider === false` opts OUT of provider web backends (forces the
 *  MCP/package path), `debug` prefixes the taken Code Path, `search`
 *  holds backend/engine config, `mcp` the server mapping, and
 *  `readability` the fetch converter toggle. */
export function settingsSchema() {
  return {
    web: {
      default: {},
      description:
        "Web tools: provider (false disables provider web backends), " +
        "debug (show the taken code path), search {backends, engines, " +
        "cache}, mcp {server, searchTool, fetchTool, shadow}, readability.",
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
