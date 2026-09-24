import { createHash, randomBytes } from "node:crypto";

const DEFAULT_LIMIT = 40;
const DEFAULT_TIMEOUT_MS = 15_000;
const ENGINE_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 3_600;
const DEFAULT_CACHE_ENTRIES = 32;
const MAX_CACHE_ENTRIES = 256;
const MAX_REDIRECTS = 8;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_CONCURRENT = 4;
const BURST_LIMIT = 8;
const BURST_WINDOW_MS = 30_000;
const ROLLING_LIMIT = 60;
const ROLLING_WINDOW_MS = 300_000;
const RRF_K = 60;
const BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.5",
  "upgrade-insecure-requests": "1",
});

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "gbraid", "wbraid", "msclkid", "dclid", "yclid", "mc_cid", "mc_eid", "igshid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_name", "utm_cid", "utm_reader",
  "utm_viz_id", "utm_pubreferrer", "utm_swu", "vero_id", "_hsenc", "_hsmi", "mkt_tok",
]);

const DEFAULT_ENGINES = Object.freeze([
  { type: "duckduckgo-html", url: "https://html.duckduckgo.com/html/" },
  { type: "mojeek-html", url: "https://www.mojeek.com/search" },
  { type: "brave-api", url: "https://api.search.brave.com/res/v1/web/search", credentialEnv: "BRAVE_API_KEY" },
]);

const cache = new Map();
const rateTimestamps = [];
let activeCalls = 0;

export function __resetPackageSearchForTest() {
  cache.clear();
  rateTimestamps.length = 0;
  activeCalls = 0;
}

class SearchConfigError extends Error {
  constructor(message) {
    super(`web-search configuration error: ${message}`);
    this.name = "SearchConfigError";
    this.actionable = true;
  }
}

class SearchBackendError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SearchBackendError";
    this.retryable = options.retryable ?? false;
    this.causes = options.causes ?? [];
  }
}

/**
 * Run the package web-search backend.
 * @param {{query: string, limit: number, wasClamped?: boolean}} args normalized search arguments
 * @param {{signal?: AbortSignal, env?: {settings?: object}}} context execution context
 * @param {{fetchImpl?: Function, clock?: {now(): number}, env?: Record<string,string|undefined>}} [options] test hooks
 * @returns {Promise<string>} Markdown search results
 */
export async function packageSearch(args, context = {}, options = {}) {
  validateArgs(args);
  const clock = options.clock ?? Date;
  const now = clock.now();
  checkRate(now);
  if (activeCalls >= MAX_CONCURRENT) throw new SearchBackendError("web-search is busy; retry after another search completes", { retryable: true });
  activeCalls += 1;
  try {
    const web = context.env?.settings?.web;
    const isDebug = readDebugSetting(web);
    const config = { ...parseSearchConfig(web?.search, options.env ?? process.env), isDebug };
    const key = cacheKey(args, config);
    const cached = readCache(key, now);
    const content = cached ?? await runSearch(args, context, options, config, now);
    if (cached === undefined) writeCache(key, content, config.cacheSeconds, config.cacheMaxEntries, clock.now());
    return appendClampNotice(content, args.wasClamped);
  } finally {
    activeCalls -= 1;
  }
}

function validateArgs(args) {
  if (!args || typeof args !== "object") throw new TypeError("web-search args must be the normalized object {query, limit, wasClamped}");
  if (typeof args.query !== "string" || args.query.trim() === "") throw new TypeError("web-search query must be a non-empty normalized string");
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > DEFAULT_LIMIT) throw new TypeError("web-search limit must be a normalized integer from 1 through 40");
}

function checkRate(now) {
  pruneTimes(rateTimestamps, now - ROLLING_WINDOW_MS);
  const burstCount = rateTimestamps.filter((value) => value > now - BURST_WINDOW_MS).length;
  if (burstCount >= BURST_LIMIT) throw new SearchBackendError("web-search burst rate limit reached; retry after 30 seconds", { retryable: true });
  if (rateTimestamps.length >= ROLLING_LIMIT) throw new SearchBackendError("web-search rolling rate limit reached; retry after 5 minutes", { retryable: true });
  rateTimestamps.push(now);
}

function pruneTimes(values, minTime) {
  while (values.length > 0 && values[0] <= minTime) values.shift();
}

async function runSearch(args, context, options, config, startTime) {
  const deadline = startTime + config.timeoutMs;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SearchConfigError("fetch is unavailable; provide options.fetchImpl or a runtime fetch");
  const errors = [];

  for (const backend of config.backends) {
    try {
      const results = await searchSearxng(backend, args.query, fetchImpl, context.signal, deadline);
      return renderMarkdown(args.query, results.slice(0, args.limit), config.isDebug ? `SearXNG (${backend.name})` : undefined, config.isDebug);
    } catch (error) {
      errors.push(formatCause(backend.name, error));
    }
  }

  if (config.engines.length === 0) {
    throw aggregateFailure("no configured search engines are enabled", errors);
  }

  const settled = await Promise.allSettled(config.engines.map((engine, index) => searchEngine(engine, index, args.query, fetchImpl, context.signal, deadline)));
  const successes = [];
  const diagnostics = [];
  for (const [index, result] of settled.entries()) {
    const name = engineLabel(config.engines[index].type);
    if (result.status === "fulfilled") {
      successes.push(result.value);
      diagnostics.push(`${name}: success (${result.value.results.length} results)`);
    } else {
      const cause = formatCause(config.engines[index].type, result.reason);
      errors.push(cause);
      diagnostics.push(`${name}: failed (${sanitizeLine(result.reason?.message ?? result.reason)})`);
    }
  }
  if (successes.length === 0) throw aggregateFailure("all configured search engines failed", errors);
  return renderMarkdown(
    args.query,
    mergeResults(successes).slice(0, args.limit),
    config.isDebug ? "engine aggregate" : undefined,
    config.isDebug,
    diagnostics,
  );
}

function aggregateFailure(summary, causes) {
  const details = causes.length === 0 ? "" : ` Attempts: ${causes.join("; ")}.`;
  return new SearchBackendError(`web-search failed: ${summary}.${details}`, { retryable: true, causes });
}

function formatCause(name, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${sanitizeLine(message)}`;
}

function readDebugSetting(web = {}) {
  if (web?.debug === undefined) return false;
  if (typeof web.debug !== "boolean") throw new SearchConfigError("web.debug must be a boolean");
  return web.debug;
}

function parseSearchConfig(settings = {}, env = {}) {
  if (settings !== undefined && !isPlainObject(settings)) throw new SearchConfigError("web.search must be an object");
  const cacheSeconds = boundedNumber(settings.cacheSeconds, DEFAULT_CACHE_SECONDS, 0, MAX_CACHE_SECONDS, "cacheSeconds");
  const cacheMaxEntries = boundedInteger(settings.cacheMaxEntries, DEFAULT_CACHE_ENTRIES, 0, MAX_CACHE_ENTRIES, "cacheMaxEntries");
  const timeoutMs = boundedInteger(settings.timeout, DEFAULT_TIMEOUT_MS, 1, DEFAULT_TIMEOUT_MS, "timeout");
  const backends = parseBackends(settings, env);
  const engines = parseEngines(settings, env);
  return { backends, engines, cacheSeconds, cacheMaxEntries, timeoutMs };
}

function parseBackends(settings, env) {
  if (settings.backends !== undefined) {
    if (!Array.isArray(settings.backends)) throw new SearchConfigError("backends must be an array");
    return settings.backends.map((entry, index) => parseSearxBackend(entry, `backends[${index}]`));
  }
  const rawUrl = env.SEARXNG_URL || env.SEARXNG_BASE;
  if (!rawUrl) return [];
  return [parseSearxBackend({ name: "searxng-env", type: "searxng", url: rawUrl }, "environment SearXNG")];
}

function parseSearxBackend(entry, path) {
  if (!isPlainObject(entry)) throw new SearchConfigError(`${path} must be an object`);
  if (entry.type !== "searxng") throw new SearchConfigError(`${path}.type must be searxng`);
  const url = parseHttpUrl(entry.url, `${path}.url`);
  return { name: stringOrDefault(entry.name, "searxng"), type: "searxng", url, token: parseToken(entry.token, path) };
}

function parseEngines(settings, env) {
  const hasExplicit = settings.engines !== undefined;
  const useDefaults = settings.default === true || (!hasExplicit && settings.default !== false);
  const explicit = hasExplicit ? parseExplicitEngines(settings.engines) : [];
  const byType = new Map(explicit.map((engine) => [engine.type, engine]));
  if (useDefaults) {
    for (const engine of DEFAULT_ENGINES) {
      if (byType.has(engine.type)) continue;
      const candidate = defaultEngine(engine, env);
      if (candidate) byType.set(engine.type, candidate);
    }
  }
  return [...byType.values()];
}

function defaultEngine(engine, env) {
  if (engine.type !== "brave-api") return parseEngine(engine, engine.type);
  const value = env[engine.credentialEnv];
  if (typeof value !== "string" || value === "") return undefined;
  return parseEngine({ ...engine, token: { header: "X-Subscription-Token", value } }, engine.type);
}

function parseExplicitEngines(value) {
  if (!Array.isArray(value)) throw new SearchConfigError("engines must be an array");
  const seen = new Set();
  return value.map((entry, index) => {
    const engine = parseEngine(entry, `engines[${index}]`);
    if (seen.has(engine.type)) throw new SearchConfigError(`duplicate engine identity: ${engine.type}`);
    seen.add(engine.type);
    return engine;
  });
}

function parseEngine(entry, path) {
  if (!isPlainObject(entry)) throw new SearchConfigError(`${path} must be an object`);
  const supported = new Set([
    "duckduckgo-html", "mojeek-html", "brave-api", "swisscows-api",
  ]);
  if (!supported.has(entry.type)) throw new SearchConfigError(`${path}.type is unsupported: ${entry.type}`);
  const token = parseToken(entry.token, path);
  if (entry.type === "brave-api" && token === undefined) {
    throw new SearchConfigError(`${path}.token is required for ${entry.type}`);
  }
  return { type: entry.type, url: parseHttpUrl(entry.url, `${path}.url`), token };
}

function parseToken(token, path) {
  if (token === undefined) return undefined;
  if (!isPlainObject(token)) throw new SearchConfigError(`${path}.token must be an object`);
  if (typeof token.header !== "string" || token.header.trim() === "") throw new SearchConfigError(`${path}.token.header must be a non-empty string`);
  if (typeof token.value !== "string" || token.value === "") throw new SearchConfigError(`${path}.token.value must be a non-empty string`);
  return { header: token.header.trim(), value: token.value };
}

function parseHttpUrl(value, path) {
  if (typeof value !== "string") throw new SearchConfigError(`${path} must be a URL string`);
  let url;
  try { url = new URL(value); } catch { throw new SearchConfigError(`${path} must be a valid URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new SearchConfigError(`${path} must use http or https`);
  if (url.username !== "" || url.password !== "") throw new SearchConfigError(`${path} must not contain embedded credentials`);
  return url.toString();
}

function stringOrDefault(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new SearchConfigError("backend name must be a non-empty string");
  return value.trim();
}

function boundedNumber(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new SearchConfigError(`${name} must be a finite number >= ${min}`);
  return Math.min(value, max);
}

function boundedInteger(value, fallback, min, max, name) {
  const number = boundedNumber(value, fallback, min, max, name);
  if (!Number.isInteger(number)) throw new SearchConfigError(`${name} must be an integer`);
  return number;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

async function searchSearxng(backend, query, fetchImpl, signal, deadline) {
  const url = new URL(backend.url);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetchWithRedirects(url, { token: backend.token, fetchImpl, signal, deadline, baseOrigin: new URL(backend.url).origin });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (type.includes("json") || looksJson(text)) return parseSearxJson(text);
  if (isChallenge(text)) throw new Error("recognized challenge page");
  return parseSearxHtml(text);
}

async function searchEngine(engine, index, query, fetchImpl, signal, packageDeadline) {
  const deadline = Math.min(Date.now() + ENGINE_TIMEOUT_MS, packageDeadline);
  if (engine.type === "duckduckgo-html") return { index, type: engine.type, results: await searchHtmlEngine(engine, query, fetchImpl, signal, deadline, parseDuckDuckGoHtml) };
  if (engine.type === "mojeek-html") return { index, type: engine.type, results: await searchHtmlEngine(engine, query, fetchImpl, signal, deadline, parseMojeekHtml) };
  if (engine.type === "swisscows-api") return { index, type: engine.type, results: await searchSwisscows(engine, query, fetchImpl, signal, deadline) };
  return { index, type: engine.type, results: await searchBrave(engine, query, fetchImpl, signal, deadline) };
}

async function searchHtmlEngine(engine, query, fetchImpl, signal, deadline, parser) {
  const url = new URL(engine.url);
  url.searchParams.set("q", query);
  const response = await fetchWithRedirects(url, { token: engine.token, fetchImpl, signal, deadline, baseOrigin: new URL(engine.url).origin });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (isChallenge(text)) throw new Error("recognized challenge page");
  return parser(text);
}

async function searchSwisscows(engine, query, fetchImpl, signal, deadline) {
  const url = new URL(engine.url);
  const args = { freshness: "All", itemsCount: "20", locale: "en-US", offset: "0", query, spellcheck: "true" };
  for (const [name, value] of Object.entries(args)) url.searchParams.set(name, value);
  const { nonce, signature } = signSwisscows(url.pathname, args);
  const response = await fetchWithRedirects(url, { token: engine.token, fetchImpl, signal, deadline, baseOrigin: new URL(engine.url).origin, accept: "application/json", extraHeaders: { "x-request-nonce": nonce, "x-request-signature": signature } });
  const json = parseJson(await response.text(), "Swisscows API returned malformed JSON");
  if (!response.ok) throw new Error(`Swisscows API HTTP ${response.status}`);
  const payload = typeof json.payload === "string" ? decodeJwtPayload(json.payload) : json;
  if (!Array.isArray(payload.items)) throw new Error("Swisscows API response was not recognized");
  return payload.items.filter((item) => item?.type === "WebPage")
    .map((item) => ({ title: textValue(item.name), url: textValue(item.url), snippet: cleanHtml(item.description ?? "") })).filter(validResult);
}

function signSwisscows(path, args) {
  const nonce = randomBytes(24).toString("base64url").slice(0, 32);
  const shifted = [...nonce].map((char) => {
    if (!/[a-z]/i.test(char)) return char;
    const code = char.toUpperCase().charCodeAt(0) - 65;
    const shiftedChar = String.fromCharCode(65 + ((code + 13) % 26));
    return char === char.toUpperCase() ? shiftedChar.toLowerCase() : shiftedChar;
  }).join("");
  const query = Object.entries(args).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join("&");
  const signature = createHash("sha256").update(`${path}?${query}${shifted}`).digest("base64url");
  return { nonce, signature };
}

function decodeJwtPayload(value) {
  const part = value.split(".")[1];
  if (!part) throw new Error("Swisscows API payload was not recognized");
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { throw new Error("Swisscows API payload was malformed"); }
}

async function searchBrave(engine, query, fetchImpl, signal, deadline) {
  const url = new URL(engine.url);
  url.searchParams.set("q", query);
  const response = await fetchWithRedirects(url, { token: engine.token, fetchImpl, signal, deadline, baseOrigin: new URL(engine.url).origin, accept: "application/json" });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = parseJson(text, "Brave API returned malformed JSON");
  const items = Array.isArray(json.web?.results) ? json.web.results : [];
  return items.map((item) => ({ title: textValue(item.title), url: textValue(item.url), snippet: textValue(item.description) })).filter(validResult);
}

async function fetchWithRedirects(initialUrl, { token, fetchImpl, signal, deadline, baseOrigin, accept, referer, origin, extraHeaders }) {
  let url = new URL(initialUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    throwIfAborted(signal);
    const headers = new Headers(BROWSER_HEADERS);
    if (accept) headers.set("accept", accept);
    if (referer) headers.set("referer", referer);
    if (origin) headers.set("origin", origin);
    if (url.origin === baseOrigin) {
      for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
      if (token) headers.set(token.header, token.value);
    }
    const response = await fetchWithDeadline(fetchImpl, url, { method: "GET", redirect: "manual", headers, signal }, deadline);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect missing Location header");
    url = parseRedirectUrl(location, url);
  }
  throw new Error("too many redirects");
}

function parseRedirectUrl(location, base) {
  const url = new URL(location, base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("redirect target must use http or https");
  if (url.username !== "" || url.password !== "") throw new Error("redirect target must not contain credentials");
  return url;
}

async function fetchWithDeadline(fetchImpl, url, init, deadline) {
  const ms = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("web-search request timed out")), ms);
  const sourceSignal = init.signal;
  const abort = () => controller.abort(sourceSignal.reason);
  try {
    if (sourceSignal?.aborted) throw sourceSignal.reason ?? new Error("web-search cancelled");
    sourceSignal?.addEventListener("abort", abort, { once: true });
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    sourceSignal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("web-search cancelled");
}

function parseSearxJson(text) {
  const json = parseJson(text, "SearXNG returned malformed JSON");
  if (!Array.isArray(json.results)) throw new Error("SearXNG JSON did not contain a results array");
  return json.results.map((item) => ({ title: textValue(item.title), url: textValue(item.url), snippet: textValue(item.content) })).filter(validResult);
}

function parseSearxHtml(text) {
  const blocks = matchAll(text, /<article\b[\s\S]*?<\/article>|<div\b[^>]*class=["'][^"']*result[^"']*["'][^>]*>[\s\S]*?<\/div>/gi);
  if (blocks.length === 0 && isRecognizedNoResults(text)) return [];
  if (blocks.length === 0) throw new Error("SearXNG HTML was not recognized");
  return blocks.map(parseGenericResultBlock).filter(validResult);
}

function parseDuckDuckGoHtml(text) {
  const blocks = matchAll(text, /<div\b[^>]*class=["']result(?:\s[^"']*)?["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["']result(?:\s|["'])|<\/body>|$)/gi);
  if (blocks.length === 0 && isRecognizedNoResults(text)) return [];
  if (blocks.length === 0) throw new Error("DuckDuckGo HTML was not recognized");
  return blocks.map(parseDuckBlock).filter(validResult);
}

function parseMojeekHtml(text) {
  const blocks = matchAll(text, /<li\b[^>]*class=["'][^"']*(?:result|r)[^"']*["'][^>]*>[\s\S]*?<\/li>|<div\b[^>]*class=["'][^"']*result[^"']*["'][^>]*>[\s\S]*?<\/div>/gi);
  if (blocks.length === 0 && isRecognizedNoResults(text)) return [];
  if (blocks.length === 0) throw new Error("Mojeek HTML was not recognized");
  return blocks.map(parseGenericResultBlock).filter(validResult);
}

function parseDuckBlock(block) {
  const href = firstMatch(block, /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    ?? firstMatch(block, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!href) return {};
  return { title: cleanHtml(href[2]), url: decodeDuckUrl(decodeEntities(href[1])), snippet: cleanHtml(firstMatch(block, /<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? firstMatch(block, /<div\b[^>]*class=["'][^"']*snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "") };
}

function parseGenericResultBlock(block) {
  const anchor = firstMatch(block, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!anchor) return {};
  const snippet = firstMatch(block, /<(?:p|div|span)\b[^>]*class=["'][^"']*(?:content|snippet|desc|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div|span)>/i)?.[1] ?? "";
  return { title: cleanHtml(anchor[2]), url: decodeEntities(anchor[1]), snippet: cleanHtml(snippet) };
}

function decodeDuckUrl(value) {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    return url.searchParams.get("uddg") ?? value;
  } catch {
    return value;
  }
}

function parseJson(text, message) {
  try { return JSON.parse(text); } catch { throw new Error(message); }
}

function looksJson(text) {
  return /^[\s\n\r]*[\[{]/.test(text);
}

function isChallenge(text) {
  return /captcha|verify you are human|unusual traffic|enable javascript|challenge-form/i.test(text);
}

function isRecognizedNoResults(text) {
  return /no results|no result|not find any results|did not match any documents/i.test(cleanHtml(text));
}

function matchAll(text, regex) {
  return [...text.matchAll(regex)].map((match) => match[0]);
}

function firstMatch(text, regex) {
  return regex.exec(text);
}

function cleanHtml(value) {
  return decodeEntities(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (literal, entity) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code)) return literal;
      try { return String.fromCodePoint(code); } catch { return literal; }
    }
    return named[entity.toLowerCase()] ?? literal;
  });
}

function textValue(value) {
  return typeof value === "string" ? cleanHtml(value) : "";
}

function validResult(result) {
  if (!result || typeof result.url !== "string" || result.url.trim() === "") return false;
  try { new URL(result.url); } catch { return false; }
  return true;
}

function mergeResults(engineOutputs) {
  const groups = new Map();
  for (const output of engineOutputs) {
    const seen = new Set();
    for (const [rankOffset, result] of output.results.entries()) {
      const key = comparisonKey(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? { key, contributions: [] };
      group.contributions.push({ engine: output.type, engineIndex: output.index, rank: rankOffset + 1, originalUrl: result.url, title: result.title, snippet: result.snippet });
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(selectMergedResult).sort(compareMergedResults);
}

function selectMergedResult(group) {
  const contributions = group.contributions.sort((a, b) => a.rank - b.rank || a.engineIndex - b.engineIndex || a.originalUrl.localeCompare(b.originalUrl));
  const engineNames = [...new Set(contributions.sort((a, b) => a.engineIndex - b.engineIndex).map((item) => engineLabel(item.engine)))];
  const fusionScore = contributions.reduce((sum, item) => sum + (1 / (RRF_K + item.rank)), 0);
  const consensusBonus = Math.max(0, engineNames.length - 1) / (RRF_K + 1);
  const score = fusionScore + consensusBonus;
  return {
    key: group.key,
    score,
    bestEngineIndex: Math.min(...contributions.map((item) => item.engineIndex)),
    bestRank: Math.min(...contributions.map((item) => item.rank)),
    title: firstNonEmpty(contributions.map((item) => item.title)),
    url: contributions[0].originalUrl,
    snippet: firstNonEmpty(contributions.map((item) => item.snippet)),
    engines: engineNames,
  };
}

function compareMergedResults(a, b) {
  return b.score - a.score || a.bestEngineIndex - b.bestEngineIndex || a.bestRank - b.bestRank || a.key.localeCompare(b.key);
}

function firstNonEmpty(values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") ?? "";
}

function comparisonKey(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  for (const name of [...url.searchParams.keys()]) if (TRACKING_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
  url.searchParams.sort();
  return url.toString();
}

function engineLabel(type) {
  return ({
    "duckduckgo-html": "duckduckgo", "mojeek-html": "mojeek", "brave-api": "brave", "swisscows-api": "swisscows",
  })[type] ?? type;
}

function renderMarkdown(query, results, codePath, isDebug = false, diagnostics = []) {
  const lines = [
    ...(codePath ? [`Code Path: ${codePath}`, ...diagnostics.map((line) => `Engine Attempt: ${line}`), ""] : []),
    `Search Results for ${JSON.stringify(query)}:`,
    "",
  ];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. **${escapeMarkdownInline(result.title || result.url)}**`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet) lines.push(`   ${escapeMarkdownInline(result.snippet)}`);
    if (isDebug) lines.push(`   Engines: ${result.engines?.join(", ") ?? "searxng"}`);
    lines.push("");
  }
  lines.push(`Found ${results.length} ${results.length === 1 ? "result" : "results"}`);
  return lines.join("\n");
}

function escapeMarkdownInline(value) {
  return String(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function appendClampNotice(content, wasClamped) {
  if (!wasClamped) return content;
  return `${content}\n\nNote: web-search returns at most ${DEFAULT_LIMIT} results; the requested limit was clamped.`;
}

function sanitizeLine(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function readCache(key, now) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.content;
}

function writeCache(key, content, seconds, maxEntries, now) {
  if (seconds <= 0 || maxEntries <= 0) return;
  cache.set(key, { content: content.slice(0, MAX_OUTPUT_CHARS), expiresAt: now + (seconds * 1_000) });
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function cacheKey(args, config) {
  const identity = {
    query: args.query,
    limit: args.limit,
    debug: config.isDebug,
    backends: config.backends.map((backend) => ({ type: backend.type, url: backend.url, tokenHeader: backend.token?.header ?? null, hasToken: Boolean(backend.token) })),
    engines: config.engines.map((engine) => ({ type: engine.type, url: engine.url, tokenHeader: engine.token?.header ?? null, hasToken: Boolean(engine.token) })),
  };
  return JSON.stringify(identity);
}
