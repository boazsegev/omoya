/** Env-private MCP protocol client. Owns era negotiation, request metadata,
 * cancellation policy, tool caching and header annotations; no transport IO. */
import { NAMES } from "../../namespace.js";
import { openStdio } from "./stdio.js";
import { openHttp } from "./http.js";

const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
const identity = { name: NAMES.agentName, version: "1" };

/** Attach mandatory stateless request fields, preserving caller metadata. */
function modernParams(params, version) {
  return { ...params, _meta: { ...params?._meta,
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": identity,
    "io.modelcontextprotocol/clientCapabilities": {},
  } };
}
function rpcError(error) {
  const result = new Error(error.message ?? "MCP request failed");
  result.code = error.code;
  result.data = error.data;
  return result;
}
function supported(error) { return error?.data?.supported ?? error?.data?.supportedVersions ?? []; }
function selectVersion(versions) {
  if (versions?.includes(MODERN)) return MODERN;
  const newer = versions?.find((version) => typeof version === "string" && version > LEGACY);
  return newer ?? null;
}
/** Statically walk schema properties; annotations behind ref/array/composition are invalid. */
function annotations(schema) {
  const found = [];
  const used = new Set();
  function walk(node, path, reachable, depth = 0) {
    if (!node || typeof node !== "object" || depth > 32) return;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      if (!reachable || typeof name !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        used.has(name.toLowerCase()) || !["integer", "string", "boolean"].includes(node.type)) {
        throw new Error(`invalid x-mcp-header at ${path.join(".") || "root"}`);
      }
      used.add(name.toLowerCase());
      found.push({ name, path, type: node.type });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-mcp-header") continue;
      if (key === "properties" && value && typeof value === "object") {
        for (const [property, child] of Object.entries(value)) walk(child, [...path, property], reachable, depth + 1);
      } else if (value && typeof value === "object") {
        for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item, path, false, depth + 1);
      }
    }
  }
  walk(schema, [], true);
  return found;
}
/** Extract annotated primitive values at their precise argument paths. */
function parameterHeaders(tool, args) {
  const result = {};
  for (const { name, path, type } of tool?.annotations ?? []) {
    const value = path.reduce((node, key) => node?.[key], args);
    if (value == null) continue;
    if (type === "integer" ? !Number.isSafeInteger(value) : typeof value !== type) {
      throw new Error(`MCP header parameter ${path.join(".")} has invalid type`);
    }
    result[name] = value;
  }
  return result;
}

/** Create a transport-independent client; eraHint belongs to the server entry. */
export function createClient(name, config, eraHint = null) {
  const isHttp = Boolean(config.url);
  const transport = isHttp ? openHttp(config) : openStdio(name, config);
  let era = null;
  let version = MODERN;
  let nextId = 0;
  let tools = null;
  let expires = 0;
  let dropped = [];
  const listCache = new Map();
  let capabilities = null;
  const annotationsByName = new Map();
  const timeout = config.timeout; // normalized by the server registry
  /** Dispatch and correlate one request, notifying stdio/legacy HTTP on interruption. */
  async function request(method, params = {}, options = {}) {
    const message = {
      jsonrpc: "2.0", id: ++nextId, method,
      params: era === "modern" ? modernParams(params, version) : params,
    };
    const settings = { timeout: options.timeout ?? timeout, signal: options.signal,
      protocolVersion: version, parameterHeaders: options.parameterHeaders };
    try {
      const response = await transport.request(message, settings);
      if (response?.error) throw rpcError(response.error);
      if (response?.result?.resultType === "input_required") {
        throw new Error("MCP server requires client input; this client advertises no input capabilities");
      }
      return response?.result;
    } catch (error) {
      if ((options.signal?.aborted || error.timedOut) &&
        !(era === "modern" && transport.cancelsByClose) && !transport.closed) {
        void transport.notify({ jsonrpc: "2.0", method: "notifications/cancelled",
          params: { requestId: message.id, reason: error.timedOut ? "Timed out" : "Cancelled" } },
        { protocolVersion: version }).catch(() => {});
      }
      if (error.sessionExpired && !options.retried && !options.signal?.aborted) {
        await initialize(options.signal);
        return request(method, params, { ...options, retried: true });
      }
      throw error;
    }
  }
  /** Legacy handshake is connected only after initialized notification succeeds. */
  async function initialize(signal) {
    era = "legacy";
    version = LEGACY;
    const result = await request("initialize", {
      protocolVersion: LEGACY, capabilities: {}, clientInfo: identity,
    }, { signal });
    version = result?.protocolVersion ?? LEGACY;
    capabilities = result?.capabilities ?? null;
    await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" },
      { protocolVersion: version, timeout, signal });
  }
  /** Probe with a bounded wait; a modern error cannot trigger legacy fallback. */
  async function discover(signal) {
    era = "modern";
    version = MODERN;
    let result;
    try { result = await request("server/discover", {}, { signal, timeout: Math.min(timeout, 5_000) }); }
    catch (error) {
      const modernError = error.rpcError ?? error;
      if (modernError.code === -32022) {
        const selected = selectVersion(supported(modernError));
        if (!selected) throw new Error(`MCP server does not support ${MODERN}`);
        version = selected;
        return;
      }
      if (signal?.aborted || error.status === 401 || error.status === 403 || error.transportFailure && !error.timedOut) throw error;
      const legacyHttp = error.status >= 400 && error.status < 500 &&
        !MODERN_ERRORS.has(error.rpcError?.code) &&
        !(error.status === 404 && error.rpcError?.code === -32601);
      if (isHttp ? legacyHttp : !MODERN_ERRORS.has(error.code)) { await initialize(signal); return; }
      throw error;
    }
    capabilities = result?.capabilities ?? null;
    const selected = selectVersion(result?.supportedVersions ?? [MODERN]);
    if (!selected) { await initialize(signal); return; }
    version = selected;
  }
  async function connect(signal) {
    if (isHttp && eraHint === "legacy") { await initialize(signal); return; }
    await discover(signal);
  }
  /** Collect all cursor pages and cache until the shortest advertised TTL. */
  async function listTools(options = {}) {
    if (tools && Date.now() < expires) return tools;
    const listed = [];
    let cursor;
    let ttl = Infinity;
    const cursors = new Set();
    do {
      const page = await request("tools/list", cursor ? { cursor } : {}, options);
      listed.push(...(Array.isArray(page?.tools) ? page.tools : []));
      ttl = Math.min(ttl, Number.isFinite(page?.ttlMs) && page.ttlMs >= 0 ? page.ttlMs : Infinity);
      cursor = page?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP tools/list repeated pagination cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    annotationsByName.clear();
    dropped = [];
    tools = listed.filter((tool) => {
      if (!isHttp) return true;
      try { annotationsByName.set(tool.name, { annotations: annotations(tool.inputSchema) }); return true; }
      catch (error) { dropped.push({ name: tool.name, reason: error.message }); return false; }
    });
    expires = ttl === Infinity ? Infinity : Date.now() + ttl;
    return tools;
  }
  /** Validate HTTP parameter annotations before sending a remote tool call. */
  async function callTool(tool, args, options = {}) {
    if (isHttp) await listTools(options);
    if (isHttp && !annotationsByName.has(tool)) {
      throw new Error(`MCP tool ${tool} is unavailable or has invalid header annotations`);
    }
    return request("tools/call", { name: tool, arguments: args ?? {} }, {
      ...options, parameterHeaders: isHttp ? parameterHeaders(annotationsByName.get(tool), args ?? {}) : {},
    });
  }
  async function list(kind, options = {}) {
    if (capabilities && !capabilities[kind]) return [];
    const cached = listCache.get(kind);
    if (cached && Date.now() < cached.expires) return cached.items;
    const items = []; const cursors = new Set(); let cursor, ttl = Infinity;
    do {
      const page = await request(`${kind}/list`, cursor ? { cursor } : {}, options);
      items.push(...(Array.isArray(page?.[kind]) ? page[kind] : []));
      ttl = Math.min(ttl, Number.isFinite(page?.ttlMs) && page.ttlMs >= 0 ? page.ttlMs : Infinity);
      cursor = page?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error(`MCP ${kind}/list repeated pagination cursor`);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    listCache.set(kind, { items, expires: ttl === Infinity ? Infinity : Date.now() + ttl });
    return items;
  }
  return {
    transport, connect, listTools, callTool,
    listResources: (options) => list("resources", options),
    readResource: (uri, options) => request("resources/read", { uri }, options),
    listPrompts: (options) => list("prompts", options),
    getPrompt: (name, args, options) => request("prompts/get", { name, arguments: args ?? {} }, options),
    get tools() { return tools; }, get dropped() { return dropped; }, get era() { return era; },
    get closed() { return transport.closed; }, close: () => transport.close(),
    onClose: (fn) => transport.onClose(fn),
  };
}
