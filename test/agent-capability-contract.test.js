import { describe, expect, test } from "bun:test";
import { Agent } from "../lib/agent.js";
import { agentSettingsSnapshot } from "../lib/agent/context-lifecycle.js";
import { testEnv } from "./fakes.js";

describe("Agent write capability", () => {
  test("interaction defaults on, can be denied, and children cannot enable it", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env });
    expect(parent.can.interact).toBe(true);
    parent.can.interact = false;
    expect(parent.can.interact).toBe(false);
    expect(parent.context.settings.can.interact).toBe(false);
    parent.can.interact = true;
    const child = await Agent.create({ env, parent, can: { interact: true } });
    expect(child.can.interact).toBe(false);
    child.can.interact = true;
    expect(child.can.interact).toBe(false);
    expect(child._can.interact).toBe(true);
    await child.close();
    await parent.close();
    await env.close();
  });
  test("has no public safe alias or constructor safe option", async () => {
    const env = await testEnv();
    const agent = await Agent.create({ env, can: { write: false } });
    expect("safe" in agent).toBe(false);
    expect(agent.can.write).toBe(false);
    expect(Object.getOwnPropertyDescriptor(Agent.prototype, "safe")).toBeUndefined();
    agent.safe = true; // Ordinary extensible JS objects permit arbitrary own fields.
    expect(agent.can.write).toBe(false); // Such a field has no authority.
    await expect(Agent.create({ env, safe: true })).rejects.toThrow(/can/);
    await agent.close();
    await env.close();
  });

  test("child cannot enable write while parent denies it", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env, can: { write: false } });
    const child = await Agent.create({ env, parent });
    child.can.write = true;
    expect(child.can.write).toBe(false);
    expect(child._can.write).toBe(true);
    parent.can.write = true;
    expect(child.can.write).toBe(!child._forcedSafe);
    child.can.write = false;
    expect(child.can.write).toBe(false);
    expect(child._can.write).toBe(false);
    await child.close();
    await parent.close();
    await env.close();
  });

  test("explicit constructor write choice overrides conflicting resumed settings", async () => {
    const env = await testEnv();
    for (const [choice, saved] of [[true, false], [false, true]]) {
      const context = new Agent.Context({ save: false, settings: { can: { write: saved } } });
      const agent = await Agent.create({ env, context, can: { write: choice } });
      expect(agent._can.write).toBe(choice);
      expect(agent.can.write).toBe(choice && !agent._forcedSafe);
      await agent.close();
    }
    await env.close();
  });

  test("omitted constructor write choice restores can.write before legacy safe", async () => {
    const env = await testEnv();
    for (const [settings, expected] of [
      [{ can: { write: false }, safe: false }, false],
      [{ can: { write: true }, safe: true }, true],
      [{ safe: true }, false],
      [{ safe: false }, true],
    ]) {
      const context = new Agent.Context({ save: false, settings });
      const agent = await Agent.create({ env, context });
      expect(agent._can.write).toBe(expected);
      expect(agent.can.write).toBe(expected && !agent._forcedSafe);
      await agent.close();
    }
    await env.close();
  });

  test("runtime write changes persist as can.write without safe or parent masking", async () => {
    const env = await testEnv();
    const parent = await Agent.create({ env, can: { write: false } });
    const child = await Agent.create({ env, parent });
    child.can.write = false;
    expect(child.context.settings.can.write).toBe(false);
    child.can.write = true;
    expect(child.can.write).toBe(false);
    expect(child.context.settings.can.write).toBe(true);
    expect(agentSettingsSnapshot(child)).toMatchObject({ can: { write: true } });
    expect(Object.hasOwn(child.context.settings, "safe")).toBe(false);
    await child.close();
    await parent.close();
    await env.close();
  });
});
