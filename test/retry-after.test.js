import { describe, it, expect } from "bun:test";
import { HttpStatusError } from "../lib/io/http.js";
import { retryAfterMs } from "../lib/io/retry-after.js";

describe("HTTP 429 retry timing", () => {
  it("reads OpenAI JSON message without losing precision", () => {
    const error = new HttpStatusError(429, "Too Many Requests", JSON.stringify({ error: { message: "Rate limit reached for tokens per min. Please try again in 8.713s." } }));
    expect(retryAfterMs(error)).toBe(8713);
  });
  it("parses only coded streaming rate limits, not exhausted quotas", () => {
    expect(retryAfterMs({ code: "rate_limit_exceeded", message: "Please try again in 0.045s." })).toBe(45);
    expect(retryAfterMs({ code: "insufficient_quota", message: "Please try again in 4s." })).toBeNull();
    expect(retryAfterMs({ response: { error: { code: "rate_limit_exceeded", message: "Please try again in 2 seconds." } } })).toBe(2000);
  });
  it("prefers Retry-After header and ignores other statuses and quota errors", () => {
    const error = new HttpStatusError(429, "", "", new Headers({ "retry-after": "2" }));
    expect(retryAfterMs(error)).toBe(2000);
    expect(retryAfterMs(new HttpStatusError(402, "", "Please try again in 8s."))).toBeNull();
    expect(retryAfterMs(new HttpStatusError(429, "", "quota exceeded"))).toBeNull();
  });
});
