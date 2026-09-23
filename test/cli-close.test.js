import { describe, expect, test } from "bun:test";
import { Env } from "../lib/env.js";
import { close } from "../lib/cli.js";

describe("CLI.close", () => {
  test("owns agent, session, and tool-resource housekeeping", () => {
    const calls = [];
    const agent = {
      cancel: () => calls.push("cancel"),
      close: () => calls.push("close"),
      session: { id: "active", file: "session.jsonl" },
    };
    Env.mcpPool.set("probe", { child: { kill: () => calls.push("tools") } });

    expect(close({ agent })).toEqual({
      agent,
      session: { id: "active", file: "session.jsonl" },
    });
    expect(calls).toEqual(["cancel", "close", "tools"]);
    expect(Env.mcpPool.size).toBe(0);
  });

  test("closes every environment agent exactly once", () => {
    let closes = 0;
    const agent = { cancel() {}, close: () => closes++, session: { id: "one" } };
    close({ env: { agents: () => [agent, agent] }, agent });
    expect(closes).toBe(1);
  });
});
