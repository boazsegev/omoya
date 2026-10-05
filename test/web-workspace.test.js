import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createWorkspace } from "../lib/app/web/workspace.js";
import { composePacketHandlers, createPacketHandlers } from "../lib/app/web/handlers.js";
import { parseClientMessage } from "../lib/app/web/protocol.js";
import { testEnv } from "./fakes.js";

// Compare literal switch labels so newly accepted protocol packets cannot silently go unhandled.
test("domain tables uniquely cover every client packet accepted by the protocol", () => {
  const protocol = readFileSync(new URL("../lib/app/web/protocol.js", import.meta.url), "utf8");
  const types = [...protocol.matchAll(/case "([a-z][a-z.-]+)"/g)].map((match) => match[1]);
  const handlers = createPacketHandlers({});
  const covered = Object.keys(handlers);
  expect(new Set(covered).size).toBe(covered.length);
  expect([...covered].sort()).toEqual([...types].sort());
  expect(() => composePacketHandlers([{ "chat.submit": () => {} }, { "chat.submit": () => {} }])).toThrow("duplicate web packet type: chat.submit");
  expect(Object.keys(createPacketHandlers({})).sort()).toEqual([...types].sort());
  expect(() => parseClientMessage('{"type":"unknown"}')).toThrow("unsupported message type");
});

test("workspace exchanges a session-list packet with a fake socket without a listening host", async () => {
  const env = await testEnv();
  const workspace = await createWorkspace({ session: { kind: "anonymous" } }, { env, options: {} });
  const sent = [];
  const ws = { readyState: WebSocket.OPEN, send: (json) => sent.push(JSON.parse(json)) };
  try {
    await workspace.open(ws);
    expect(sent.some((packet) => packet.type === "hello")).toBe(true);
    sent.length = 0;
    await workspace.message(ws, JSON.stringify({ type: "session.list" }));
    expect(sent.find((packet) => packet.type === "sessions")?.agents).toBeArray();
    await workspace.message(ws, JSON.stringify({ type: "not-supported" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", message: "unsupported message type" });
  } finally { workspace.close(ws); workspace.stop(); }
});
