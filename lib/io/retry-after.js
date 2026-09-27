// Extract a bounded wait from a genuine HTTP 429 or a provider's coded
// streaming rate limit. Quota exhaustion is not a transient rate limit.
const MAX_DELAY_MS = 2_147_483_647;

export function retryAfterMs(error) {
  const code = error?.code ?? error?.error?.code ?? error?.response?.error?.code;
  const type = error?.type ?? error?.error?.type ?? error?.response?.error?.type;
  if (error?.status !== 429 && code !== "rate_limit_exceeded" && type !== "rate_limit_error") return null;
  if (code === "insufficient_quota" || type === "insufficient_quota") return null;
  const header = error.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return Math.min(MAX_DELAY_MS, Math.ceil(delay));
  }
  let body = error.body ?? error.error?.message ?? error.response?.error?.message ?? error.message;
  if (typeof body !== "string") return null;
  try { body = JSON.parse(body)?.error?.message ?? body; } catch { /* plain text */ }
  const match = /please try again in\s+([\d.]+)\s*(milliseconds?|ms|seconds?|s)\b/i.exec(String(body));
  if (!match) return null;
  const delay = Number(match[1]) * (/^(ms|millisecond)/i.test(match[2]) ? 1 : 1000);
  return Number.isFinite(delay) && delay > 0 ? Math.min(MAX_DELAY_MS, Math.ceil(delay)) : null;
}
