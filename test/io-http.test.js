// test/io-http.test.js — proof for the default HTTP backend
// (lib/io/http.js, private to IO) over a mock fetch.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  HttpStatusError,
  defaultConnect as httpConnect,
  defaultSendHeaders as httpSendHeaders,
  defaultSendBody as httpSendBody,
  defaultSend as httpSend,
  defaultRead as httpRead,
  defaultClose as httpClose,
} from "../lib/io/http.js";

const realFetch = globalThis.fetch;
let mock;
beforeEach(() => {
  mock = { calls: [], handler: () => new Response("") };
  globalThis.fetch = (...args) => {
    mock.calls.push(args);
    return mock.handler(...args);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** SSE/NDJSON body from lines. */
function streamOf(lines) {
  const text = lines.map((l) => l + "\n").join("");
  return new Response(text);
}

describe("httpConnect", () => {
  test("returns the stateless {url, aiio} connection", () => {
    const aiio = { marker: 1 };
    const conn = httpConnect("http://x/api", aiio);
    expect(conn).toEqual({ url: "http://x/api", aiio });
    expect(conn.aiio).toBe(aiio); // connection-scoped owner
  });
});

describe("httpSend composition", () => {
  test("send composes sendHeaders(msg[0]) + sendBody(msg[1])", async () => {
    const conn = httpConnect("http://x/chat", { requestSignal: undefined });
    await httpSend(conn, [{ "content-type": "application/json" }, { a: 1 }]);
    const [url, init] = mock.calls[0];
    expect(url).toBe("http://x/chat");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(conn.response).toBeInstanceOf(Response);
  });

  test("nil body sends no payload (streaming GET-style)", async () => {
    const conn = httpConnect("http://x/chat", {});
    await httpSend(conn, [{ authorization: "Bearer t" }, null]);
    expect(mock.calls[0][1].body).toBeUndefined();
  });

  test("aiio.requestSignal is wired into fetch", async () => {
    const ctrl = new AbortController();
    const conn = httpConnect("http://x/chat", { requestSignal: ctrl.signal });
    await httpSend(conn, [{}, { a: 1 }]);
    expect(mock.calls[0][1].signal).toBe(ctrl.signal);
  });

  test("non-2xx throws HttpStatusError with status and body", async () => {
    mock.handler = () => new Response("nope", { status: 401, statusText: "Unauthorized" });
    const conn = httpConnect("http://x/chat", {});
    try {
      await httpSend(conn, [{}, {}]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpStatusError);
      expect(err.status).toBe(401);
      expect(err.body).toBe("nope");
    }
  });
});

describe("httpRead blocking-await line reader", () => {
  async function connected(lines) {
    mock.handler = () => streamOf(lines);
    const conn = httpConnect("http://x/chat", {});
    await httpSend(conn, [{}, {}]);
    return conn;
  }

  test("reads whole NDJSON messages, nil at end-of-stream", async () => {
    const conn = await connected([`{"a":1}`, `{"b":2}`]);
    expect(await httpRead(conn)).toEqual({ a: 1 });
    expect(await httpRead(conn)).toEqual({ b: 2 });
    expect(await httpRead(conn)).toBeNull();
  });

  test("strips SSE data: prefixes; [DONE] ends the stream", async () => {
    const conn = await connected([`data: {"x":1}`, ``, `data: [DONE]`, `data: {"x":9}`]);
    expect(await httpRead(conn)).toEqual({ x: 1 });
    expect(await httpRead(conn)).toBeNull();
  });

  // OpenAI Responses SSE regression: framing lines are NOT JSON
  test("skips SSE framing lines (event:/id:/retry:/comments), delivering only data payloads", async () => {
    const conn = await connected([
      `event: response.created`,
      `data: {"type":"response.created"}`,
      ``,
      `: keep-alive`,
      `id: msg_1`,
      `retry: 3000`,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"hi"}`,
      `data: [DONE]`,
    ]);
    expect(await httpRead(conn)).toEqual({ type: "response.created" });
    expect(await httpRead(conn)).toEqual({ type: "response.output_text.delta", delta: "hi" });
    expect(await httpRead(conn)).toBeNull();
  });

  test("buffers messages split across stream chunks", async () => {
    const chunks = [`{"a`, `":1}\n{"b":2}\n`];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    mock.handler = () => new Response(stream);
    const conn = httpConnect("http://x/chat", {});
    await httpSend(conn, [{}, {}]);
    expect(await httpRead(conn)).toEqual({ a: 1 });
    expect(await httpRead(conn)).toEqual({ b: 2 });
    expect(await httpRead(conn)).toBeNull();
  });

  test("malformed JSON line throws SyntaxError", async () => {
    const conn = await connected([`{not json}`]);
    expect(httpRead(conn)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("read before send is an ordinary error", async () => {
    const conn = httpConnect("http://x/chat", {});
    expect(httpRead(conn)).rejects.toThrow(/read before send/);
  });
});

describe("httpClose", () => {
  test("cancels the stream; idempotent; tolerates empty connections", async () => {
    mock.handler = () => streamOf([`{"a":1}`]);
    const conn = httpConnect("http://x/chat", {});
    await httpSend(conn, [{}, {}]);
    await httpRead(conn);
    await httpClose(conn);
    await httpClose(conn); // idempotent
    expect(conn.closed).toBe(true);
    await httpClose({}); // no response at all
  });
});
