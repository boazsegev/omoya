import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMITS = Object.freeze({
  timeout: 20_000,
  maxRedirects: 8,
  maxBytes: 5_000_000,
  maxCharacters: 50_000,
  cacheSeconds: 300,
  cacheMaxEntries: 32,
  concurrency: 4,
  burstCalls: 8,
  burstWindowMs: 30_000,
  rollingCalls: 60,
  rollingWindowMs: 300_000,
});

const HARD_LIMITS = Object.freeze({
  timeout: 20_000,
  maxRedirects: 8,
  maxBytes: 5_000_000,
  maxCharacters: 50_000,
  cacheSeconds: 3_600,
  cacheMaxEntries: 256,
  concurrency: 16,
});

const JSON_TYPES = new Set(["application/json", "application/ld+json", "text/json"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/xml", "text/xml"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const CACHE = new Map();
const RATE_STATE = { active: 0, calls: [] };
let readabilityProbe;

/** Start the one-time optional dependency probe during tool loading. */
export function initializeReadability(isEnabled = true, options = {}) {
  if (isEnabled && !readabilityProbe) {
    readabilityProbe = probeReadability(options.importModule ?? importModuleDefault);
  }
  return readabilityProbe;
}

export function __resetPackageFetchForTests() {
  CACHE.clear();
  RATE_STATE.active = 0;
  RATE_STATE.calls = [];
  readabilityProbe = undefined;
}

/**
 * Fetches one HTTP(S) URL and returns a textual provenance envelope plus body.
 * @param {{url: string}} args Normalized package args.
 * @param {{signal?: AbortSignal, env?: {settings?: object}}} [context]
 * @param {{fetch?: Function, now?: Function, importModule?: Function, readability?: object|null}} [options]
 * @returns {Promise<string>}
 */
export async function packageFetch(args, context = {}, options = {}) {
  const limits = readLimits(context.env?.settings?.web?.fetch, options.limits);
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw actionableError("web-fetch package backend requires a fetch implementation", "configuration");
  }

  const requestUrl = validateUrl(args?.url, "url");
  const isReadabilityEnabled = readReadabilitySetting(context.env?.settings?.web);
  const cacheKey = `${isReadabilityEnabled ? "readability" : "builtin"}:${requestUrl.href}`;
  await enterRateLimit(limits, clock);
  try {
    const cached = readCache(cacheKey, clock, limits);
    if (cached) {
      return renderEnvelope(cached, limits.maxCharacters);
    }
    if (isReadabilityEnabled) await resolveReadability(options);

    const signal = makeSignal(context.signal, limits.timeout);
    try {
      const fetched = await fetchWithRedirects(requestUrl, fetchImpl, signal.signal, limits);
      const body = await responseToBody(fetched.response, limits, signal.signal);
      const rendered = await renderBody(body, fetched.finalUrl, { ...options, isReadabilityEnabled });
      const entry = makeEntry(requestUrl.href, fetched.finalUrl.href, fetched.response, rendered, clock);
      const output = renderEnvelope(entry, limits.maxCharacters);
      writeCache(cacheKey, entry, fetched.response, clock, limits);
      return output;
    } finally {
      signal.dispose();
    }
  } finally {
    RATE_STATE.active -= 1;
  }
}

function readReadabilitySetting(web = {}) {
  if (web?.readability === undefined) return true;
  if (typeof web.readability !== "boolean") {
    throw actionableError("web.readability must be a boolean", "configuration");
  }
  return web.readability;
}

function readLimits(settings = {}, overrides = {}) {
  const merged = { ...DEFAULT_LIMITS, ...settings, ...overrides };
  return {
    timeout: finiteInt("fetch.timeout", merged.timeout, 1, HARD_LIMITS.timeout),
    maxRedirects: finiteInt("fetch.maxRedirects", merged.maxRedirects, 0, HARD_LIMITS.maxRedirects),
    maxBytes: finiteInt("fetch.maxBytes", merged.maxBytes, 1, HARD_LIMITS.maxBytes),
    maxCharacters: finiteInt("fetch.maxCharacters", merged.maxCharacters, 1, HARD_LIMITS.maxCharacters),
    cacheSeconds: finiteInt("fetch.cacheSeconds", merged.cacheSeconds, 0, HARD_LIMITS.cacheSeconds),
    cacheMaxEntries: finiteInt("fetch.cacheMaxEntries", merged.cacheMaxEntries, 1, HARD_LIMITS.cacheMaxEntries),
    concurrency: finiteInt("fetch.concurrency", merged.concurrency, 1, HARD_LIMITS.concurrency),
    burstCalls: finiteInt("fetch.burstCalls", merged.burstCalls, 1, 1_000),
    burstWindowMs: finiteInt("fetch.burstWindowMs", merged.burstWindowMs, 1, 3_600_000),
    rollingCalls: finiteInt("fetch.rollingCalls", merged.rollingCalls, 1, 10_000),
    rollingWindowMs: finiteInt("fetch.rollingWindowMs", merged.rollingWindowMs, 1, 3_600_000),
  };
}

function finiteInt(name, value, min, max) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw actionableError(`${name} must be an integer from ${min} through ${max}`, "configuration");
  }
  return value;
}

function validateUrl(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw actionableError(`web-fetch ${field} must be a non-empty HTTP(S) URL`, "input");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw actionableError(`web-fetch ${field} is not a valid URL`, "input");
  }
  validateHopUrl(parsed);
  return parsed;
}

function validateHopUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw actionableError("web-fetch only supports HTTP(S) URLs", "input");
  }
  if (url.username !== "" || url.password !== "") {
    throw actionableError("web-fetch URLs must not contain embedded credentials", "input");
  }
}

async function enterRateLimit(limits, clock) {
  const now = clockTime(clock);
  RATE_STATE.calls = RATE_STATE.calls.filter((time) => now - time < limits.rollingWindowMs);
  const burstCount = RATE_STATE.calls.filter((time) => now - time < limits.burstWindowMs).length;
  if (RATE_STATE.active >= limits.concurrency) {
    throw retryableError("web-fetch concurrency limit reached; retry later", 1_000);
  }
  if (burstCount >= limits.burstCalls) {
    throw retryableError("web-fetch burst rate limit reached; retry later", nextRetry(RATE_STATE.calls, now, limits.burstWindowMs));
  }
  if (RATE_STATE.calls.length >= limits.rollingCalls) {
    throw retryableError("web-fetch rolling rate limit reached; retry later", nextRetry(RATE_STATE.calls, now, limits.rollingWindowMs));
  }
  RATE_STATE.active += 1;
  RATE_STATE.calls.push(now);
}

function nextRetry(calls, now, windowMs) {
  const oldest = Math.min(...calls);
  return Math.max(1, oldest + windowMs - now);
}

function clockTime(clock) {
  const value = clock();
  return value instanceof Date ? value.getTime() : Number(value);
}

function makeSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new Error("web-fetch cancelled"));
  const timer = setTimeout(() => controller.abort(new Error("web-fetch timed out")), timeoutMs);
  if (parent?.aborted) abort();
  parent?.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener?.("abort", abort);
    },
  };
}

async function fetchWithRedirects(initialUrl, fetchImpl, signal, limits) {
  let current = initialUrl;
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    const response = await fetchImpl(current.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
        "user-agent": "omoya-web-fetch/1",
      },
    });
    if (!isRedirect(response.status)) {
      if (response.status < 200 || response.status >= 300) {
        throw actionableError(`web-fetch HTTP ${response.status} from ${current.href}`, "http");
      }
      return { response, finalUrl: current };
    }
    if (hop === limits.maxRedirects) {
      throw actionableError(`web-fetch exceeded ${limits.maxRedirects} redirect hops`, "redirect");
    }
    const location = response.headers?.get?.("location");
    if (!location) {
      throw actionableError("web-fetch redirect response lacked a Location header", "redirect");
    }
    current = new URL(location, current);
    validateHopUrl(current);
  }
  throw actionableError("web-fetch redirect handling failed unexpectedly", "redirect");
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function responseToBody(response, limits, signal) {
  const bytes = await readBoundedBytes(response, limits.maxBytes, signal);
  const text = new TextDecoder(detectCharset(response.headers?.get?.("content-type"))).decode(bytes);
  return { text, mediaType: mediaTypeOf(response.headers?.get?.("content-type")), byteLength: bytes.byteLength };
}

async function readBoundedBytes(response, maxBytes, signal) {
  if (!response.body?.getReader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw actionableError(`web-fetch response exceeded ${maxBytes} bytes`, "limits");
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("web-fetch cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw actionableError(`web-fetch response exceeded ${maxBytes} bytes`, "limits");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function detectCharset(contentType) {
  const match = /charset\s*=\s*([^;]+)/i.exec(contentType ?? "");
  const charset = match?.[1]?.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return charset || "utf-8";
}

function mediaTypeOf(contentType) {
  return (contentType ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
}

async function renderBody(body, finalUrl, options) {
  if (JSON_TYPES.has(body.mediaType) || body.mediaType.endsWith("+json")) {
    return renderJson(body.text);
  }
  if (HTML_TYPES.has(body.mediaType)) {
    return { kind: "html", text: await renderHtml(body.text, finalUrl, options) };
  }
  if (TEXT_TYPES.has(body.mediaType) || body.mediaType.startsWith("text/")) {
    return { kind: "text", text: body.text };
  }
  throw actionableError(`web-fetch unsupported media type: ${body.mediaType || "unknown"}`, "media");
}

function renderJson(text) {
  try {
    return { kind: "json", text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    throw actionableError("web-fetch received malformed JSON", "media");
  }
}

async function renderHtml(html, finalUrl, options) {
  if (isChallengePage(html)) {
    throw actionableError("web-fetch cannot retrieve challenge, CAPTCHA, or anti-bot pages", "challenge");
  }
  if (isScriptShell(html)) {
    throw actionableError("web-fetch cannot read empty JavaScript-rendered pages without server HTML", "challenge");
  }
  const readable = await extractWithReadability(html, finalUrl, options);
  const source = readable ?? extractRelevantHtml(html);
  const baseUrl = htmlBaseUrl(html, finalUrl);
  const markdown = htmlToMarkdown(source, baseUrl).trim();
  if (markdown === "") {
    throw actionableError("web-fetch found no readable HTML content", "media");
  }
  return markdown;
}

function isChallengePage(html) {
  return /captcha|cloudflare|cf-browser-verification|checking your browser|access denied|are you a human/i.test(html);
}

function isScriptShell(html) {
  const stripped = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "").trim();
  const scriptBytes = [...html.matchAll(/<script\b[\s\S]*?<\/script>/gi)].reduce((sum, match) => sum + match[0].length, 0);
  return stripped.length < 80 && scriptBytes > html.length * 0.25;
}

async function extractWithReadability(html, finalUrl, options) {
  if (options.isReadabilityEnabled === false || options.readability === null) return undefined;
  const readable = options.readability ?? await resolveReadability(options);
  if (!readable) return undefined;
  try {
    const document = readable.createDocument(html, finalUrl.href);
    const article = new readable.Readability(document, { keepClasses: false }).parse();
    return article?.content || undefined;
  } catch {
    return undefined;
  }
}

async function resolveReadability(options) {
  return options.readability ?? initializeReadability(true, options);
}

async function probeReadability(importModule) {
  const domPackages = ["linkedom", "happy-dom", "jsdom"];
  const roots = globalModuleRoots();
  const readabilityModule = await importFirst("@mozilla/readability", roots, importModule);
  const Readability = readabilityModule?.Readability ?? readabilityModule?.default?.Readability;
  if (typeof Readability !== "function") return undefined;
  for (const name of domPackages) {
    const createDocument = await documentFactory(name, roots, importModule);
    if (createDocument) return { Readability, createDocument };
  }
  return undefined;
}

function globalModuleRoots() {
  const bunRoot = typeof process.env.BUN_INSTALL === "string" && process.env.BUN_INSTALL !== ""
    ? process.env.BUN_INSTALL
    : join(homedir(), ".bun");
  return [join(bunRoot, "install", "global", "node_modules")];
}

async function importFirst(name, roots, importModule) {
  try { return await importModule(name); } catch { /* try explicit Bun global roots */ }
  for (const root of roots) {
    try { return await importModule(pathToFileURL(join(root, name)).href); } catch { /* next root */ }
  }
  return undefined;
}

async function importModuleDefault(specifier) {
  return import(specifier);
}

async function documentFactory(name, roots, importModule) {
  try {
    const mod = await importFirst(name, roots, importModule);
    if (!mod) return undefined;
    if (name === "linkedom" && typeof mod.parseHTML === "function") {
      return (html) => mod.parseHTML(html).document;
    }
    if (name === "happy-dom" && typeof mod.Window === "function") {
      return (html, url) => {
        const window = new mod.Window({ url });
        window.document.write(html);
        return window.document;
      };
    }
    if (name === "jsdom" && typeof mod.JSDOM === "function") {
      return (html, url) => new mod.JSDOM(html, { url }).window.document;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractRelevantHtml(html) {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  return firstTag(cleaned, "main") ?? firstTag(cleaned, "article") ?? firstTag(cleaned, "body") ?? cleaned;
}

function firstTag(html, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return match?.[1];
}

function htmlBaseUrl(html, finalUrl) {
  const match = /<base\b[^>]*href\s*=\s*(["'])(.*?)\1/i.exec(html);
  if (!match) return finalUrl;
  try {
    const base = new URL(decodeEntities(match[2]), finalUrl);
    validateHopUrl(base);
    return base;
  } catch {
    return finalUrl;
  }
}

function htmlToMarkdown(html, baseUrl) {
  let text = html;
  const blocks = [];
  text = preservePreBlocks(text, blocks);
  text = renderTables(text);
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => `\n\n${"#".repeat(Number(level))} ${inlineText(body, baseUrl)}\n\n`);
  text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, body) => `\n\n${inlineText(body, baseUrl)}\n\n`);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => `\n- ${inlineText(body, baseUrl)}`);
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, body) => `\n\n> ${inlineText(body, baseUrl)}\n\n`);
  text = text.replace(/<(?:div|section|header|footer|nav|aside|ul|ol)\b[^>]*>/gi, "\n").replace(/<\/(?:div|section|header|footer|nav|aside|ul|ol)>/gi, "\n");
  text = inlineText(text, baseUrl);
  text = restorePreBlocks(text, blocks);
  return normalizeMarkdown(text);
}

function preservePreBlocks(html, blocks) {
  return html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const code = decodeEntities(body.replace(/<[^>]*>/g, ""));
    const token = `\u0000PRE${blocks.length}\u0000`;
    blocks.push(`\n\n\`\`\`\n${code.replace(/^\n|\n$/g, "")}\n\`\`\`\n\n`);
    return token;
  });
}

function restorePreBlocks(text, blocks) {
  return text.replace(/\u0000PRE(\d+)\u0000/g, (_, index) => blocks[Number(index)] ?? "");
}

function renderTables(html) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cleanInline(cell[1]))).filter((row) => row.length > 0);
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
    const header = normalized[0];
    const separator = Array(width).fill("---");
    return `\n\n| ${header.join(" | ")} |\n| ${separator.join(" | ")} |\n${normalized.slice(1).map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
  });
}

function inlineText(html, baseUrl) {
  let text = html;
  text = text.replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _quote, href, body) => {
    const label = cleanInline(body) || href;
    try {
      return `[${label}](${new URL(decodeEntities(href), baseUrl).href})`;
    } catch {
      return label;
    }
  });
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body) => `**${cleanInline(body)}**`);
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, body) => `_${cleanInline(body)}_`);
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => `\`${decodeEntities(body.replace(/<[^>]*>/g, "")).trim()}\``);
  return cleanInline(text);
}

function cleanInline(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/[ \t\f\v]+/g, " ").replace(/ *\n+ */g, "\n").trim();
}

function normalizeMarkdown(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[entity.toLowerCase()] ?? _;
  });
}

function makeEntry(sourceUrl, finalUrl, response, rendered, clock) {
  return {
    sourceUrl,
    finalUrl,
    retrieved: isoTime(clock),
    kind: rendered.kind,
    body: rendered.text,
    cacheControl: response.headers?.get?.("cache-control") ?? "",
  };
}

function isoTime(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(Number(value)).toISOString();
}

function renderEnvelope(entry, maxCharacters) {
  const truncated = truncateText(entry.body, maxCharacters);
  const lines = [`Source: ${entry.sourceUrl}`];
  if (entry.finalUrl !== entry.sourceUrl) lines.push(`Final URL: ${entry.finalUrl}`);
  lines.push(`Retrieved: ${entry.retrieved}`);
  if (truncated.wasTruncated) {
    const suffix = entry.kind === "json" ? "; incomplete JSON" : "";
    lines.push(`Truncated: yes (${truncated.kept} of ${truncated.total} characters${suffix})`);
  }
  return `${lines.join("\n")}\n\n${truncated.text}`;
}

function truncateText(text, maxCharacters) {
  const chars = Array.from(text);
  if (chars.length <= maxCharacters) {
    return { text, wasTruncated: false, kept: chars.length, total: chars.length };
  }
  return { text: chars.slice(0, maxCharacters).join(""), wasTruncated: true, kept: maxCharacters, total: chars.length };
}

function readCache(key, clock, limits) {
  if (limits.cacheSeconds === 0) return undefined;
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (clockTime(clock) >= entry.expiresAt) {
    CACHE.delete(key);
    return undefined;
  }
  CACHE.delete(key);
  CACHE.set(key, entry);
  return entry.value;
}

function writeCache(key, value, response, clock, limits) {
  const ttl = cacheTtlSeconds(response.headers?.get?.("cache-control"), limits.cacheSeconds);
  if (ttl <= 0) return;
  CACHE.set(key, { value, expiresAt: clockTime(clock) + ttl * 1_000 });
  while (CACHE.size > limits.cacheMaxEntries) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

function cacheTtlSeconds(cacheControl, defaultTtl) {
  const cc = (cacheControl ?? "").toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(cc)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc);
  if (maxAge) return Math.min(Number(maxAge[1]), HARD_LIMITS.cacheSeconds);
  return defaultTtl;
}

function actionableError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function retryableError(message, retryAfterMs) {
  const error = actionableError(`${message} (retry after ${retryAfterMs} ms)`, "rate_limit");
  error.retryable = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}
