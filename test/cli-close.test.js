import { describe, expect, test } from "bun:test";
import { close } from "../lib/cli.js";

describe("CLI.close", () => {
  test("owns agent, session, and tool-resource housekeeping", () => {
    const calls = [];
    const agent = {
      cancel: () => calls.push("cancel"),
      close: () => calls.push("close"),
      context: { id: "active", file: "session.jsonl" },
    };
    const env = { agents: () => [agent], close: () => calls.push("env") };

    expect(close({ env, agent })).toEqual({
      agent,
      session: { id: "active", file: "session.jsonl" },
    });
    expect(calls).toEqual(["cancel", "close", "env"]);
  });

  test("closes every environment agent exactly once", () => {
    let closes = 0;
    const agent = { cancel() {}, close: () => closes++, session: { id: "one" } };
    close({ env: { agents: () => [agent, agent] }, agent });
    expect(closes).toBe(1);
  });
});
