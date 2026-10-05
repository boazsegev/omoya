import { describe, expect, test } from "bun:test";

const guardScript = `
  const blocked = ['http://localhost:11434/api/tags', 'http://localhost:1234/v1/models']
    .map((url) => { try { fetch(url); return null; } catch (error) { return error.message; } });
  process.stdout.write(JSON.stringify({
    blocked,
    home: process.env.HOME,
    key: process.env.OPENAI_API_KEY,
  }));
`;

describe("test-spawn isolation", () => {
  test("an unconfigured child inherits the sanitized environment and blocked model ports", async () => {
    const child = Bun.spawn([process.execPath, "-e", guardScript], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.blocked).toEqual([
      "live model server fetch forbidden in tests: http://localhost:11434/api/tags",
      "live model server fetch forbidden in tests: http://localhost:1234/v1/models",
    ]);
    expect(result.home).toBe(process.env.HOME);
    expect(result.key).toBeUndefined();
  });

  test("synchronous children also reject the real model ports", () => {
    const script = `try { fetch('http://localhost:11434/api/tags'); } catch (error) { process.stdout.write(error.message); }`;
    const child = Bun.spawnSync(["bun", "-e", script]);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("live model server fetch forbidden in tests: http://localhost:11434/api/tags");
  });

  test("a child with an explicit environment keeps its test key and can fetch a fake server", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: ["fixture"] }) });
    try {
      const script = `const result = await fetch('http://127.0.0.1:${server.port}/api/tags'); process.stdout.write(JSON.stringify({ models: await result.json(), key: process.env.OPENAI_API_KEY }));`;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, OPENAI_API_KEY: "fixture-key" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exit, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ models: { models: ["fixture"] }, key: "fixture-key" });
    } finally {
      server.stop(true);
    }
  });
});
