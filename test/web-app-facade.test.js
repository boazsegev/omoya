import { expect, test } from "bun:test";
import Web from "../lib/app/web/index.js";
import { parseClientMessage } from "../lib/app/web/protocol.js";
import { MAX_WS_PAYLOAD_LENGTH } from "../lib/app/web/host.js";

test("Web facade exposes only serve while protocol and host retain their own symbols", () => {
  expect(Object.keys(Web)).toEqual(["serve"]);
  expect(typeof Web.serve).toBe("function");
  expect(Web.createWebServer).toBeUndefined();
  expect(Web.AgentSession).toBeUndefined();
  expect(Web.parseClientMessage).toBeUndefined();
  expect(Web.MAX_WS_PAYLOAD_LENGTH).toBeUndefined();
  expect(parseClientMessage(JSON.stringify({ type: "app.exit" }))).toEqual({ type: "app.exit" });
  expect(MAX_WS_PAYLOAD_LENGTH).toBe(2 * 1024 * 1024);
});
