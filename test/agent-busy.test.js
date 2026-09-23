// test/agent-busy.test.js — proof for the Agent's public turn/connection
// surface (the TUI's status indicator): busy while a run is in flight,
// ioState idle/working/disconnected — Agent owns the flag (IO owns
// the request state; the TUI only reads).
import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { scriptedIO, fakeIO, testEnv, USER, TEXT } from "./fakes.js";

describe("Agent busy / ioState (public TUI surface)", () => {
  test("busy is true while a run is in flight, false before and after", async () => {
    const env = await testEnv();
    let release;
    const io = fakeIO(async (_io, callbacks) => {
      await new Promise((resolve) => { release = resolve; });
      const { emitScript } = await import("./fakes.js");
      return emitScript([...TEXT(0, "answer"), { type: "done" }], callbacks);
    });
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });

    expect(agent.busy).toBe(false); // fresh: no run
    expect(agent.ioState).toBe("idle"); // no connection yet is NOT a failure
    const run = agent.run();
    await Bun.sleep(10); // the request is in flight
    expect(agent.busy).toBe(true);
    expect(agent.ioState).toBe("working");
    release();
    const terminal = await run;
    expect(terminal.type).toBe("done");
    expect(agent.busy).toBe(false);
    expect(agent.ioState).toBe("idle"); // a success holds/clears idle
  });

  test("a connection-class error marks disconnected until a request succeeds", async () => {
    const env = await testEnv();
    env.settings.maxAttempts = 1; // one shot: this test asserts the post-FAILURE surface, not the retry wait
    const io = scriptedIO([
      [{ type: "error", error: "connection refused", kind: "network" }],
      [...TEXT(0, "recovered"), { type: "done" }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });

    const failed = await agent.run();
    expect(failed.type).toBe("error");
    expect(agent.busy).toBe(false);
    expect(agent.ioState).toBe("disconnected");

    const recovered = await agent.run();
    expect(recovered.type).toBe("done");
    expect(agent.ioState).toBe("idle"); // the success cleared it
  });

  test("a cancelled turn is NOT a disconnect (user action, not a failure)", async () => {
    const env = await testEnv();
    const io = scriptedIO([
      [{ type: "error", error: "cancelled", kind: "cancelled", cancelled: true }],
    ]);
    const agent = new Agent({ env, model: "p/m", context: [USER("go")], createIO: () => io });
    await agent.run();
    expect(agent.ioState).toBe("idle");
  });
});
