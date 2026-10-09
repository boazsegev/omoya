import { describe, expect, test } from "bun:test";
import { close } from "../lib/app/cli.js";

describe("CLI.close", () => {
  test("owns agent, session, and tool-resource housekeeping", async () => {
    const calls = [];
    const agent = {
      cancel: () => calls.push("cancel"),
      close: () => calls.push("close"),
      context: { id: "active", file: "session.jsonl" },
    };
    const env = { agents: () => [agent], close: () => calls.push("env") };

    expect(await close({ env, agent })).toEqual({
      agent,
      session: { id: "active", file: "session.jsonl" },
    });
    expect(calls).toEqual(["cancel", "close", "env"]);
  });

  test("reports asynchronous cleanup failures after attempting all releases", async () => {
    const agent = {
      cancel: () => Promise.reject(new Error("cancel rejected")),
      close: () => Promise.reject(new Error("agent close rejected")),
      context: { id: "rejecting" },
    };
    const env = { agents: () => [agent], close: () => Promise.reject(new Error("env close rejected")) };
    await expect(close({ env, agent })).rejects.toThrow("CLI runtime failed to close");
  });

  test("closes every environment agent exactly once", async () => {
    let closes = 0;
    const agent = { cancel() {}, close: () => closes++, session: { id: "one" } };
    await close({ env: { agents: () => [agent, agent] }, agent });
    expect(closes).toBe(1);
  });
});
