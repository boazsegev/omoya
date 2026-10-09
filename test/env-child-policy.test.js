import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { childEnv } from "../lib/util.js";
import { bash } from "../tools/bash.js";
import { backgroundStart, stopAll } from "../lib/sandbox/background.js";
import { createServers } from "../lib/env/mcp/servers.js";

const SECRET = "OMOYA_STORE_SECRET_TEST";
const NORMAL = "OMOYA_STORE_NORMAL_TEST";
const saved = { secret: process.env[SECRET], normal: process.env[NORMAL] };
const command = `printf '%s:%s' "\${${SECRET}-absent}" "\${${NORMAL}-absent}"`;
const settings = { env: { [SECRET]: false, [NORMAL]: "policy-added" } };
afterEach(() => {
  if (saved.secret === undefined) delete process.env[SECRET]; else process.env[SECRET] = saved.secret;
  if (saved.normal === undefined) delete process.env[NORMAL]; else process.env[NORMAL] = saved.normal;
});

test("credential-like inherited names are removed unless explicitly passed through", () => {
  const withheld = ["OPENAI_API_KEY", "MY_AUTH_TOKEN", "SERVICE_TOKEN", "X_KEY", "SESSION_AUTH", "IMAP_KEY_2",
    "GOOGLE_OAUTH_CLIENT_ID", "DB_PASSWORD", "SMTP_PASS", "pass_file", "JWT_SECRET", "STRIPE_WEBHOOK_SECRET"];
  const inherited = ["MONKEY", "TOKENIZER", "AUTHENTICATED", "PASSPORT_ID", "COMPASS", "SECRETARY"];
  const names = [...withheld, ...inherited];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `source-${name}`;
  try {
    for (const name of withheld) expect(childEnv({})[name], name).toBeUndefined();
    for (const name of inherited) expect(childEnv({})[name], name).toBe(`source-${name}`);
    expect(childEnv({ env: { OPENAI_API_KEY: true } }).OPENAI_API_KEY).toBe("source-OPENAI_API_KEY");
    expect(childEnv({ env: { OPENAI_API_KEY: "replacement" } }).OPENAI_API_KEY).toBe("replacement");
    expect(childEnv({ env: { OPENAI_API_KEY: false } }).OPENAI_API_KEY).toBeUndefined();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});

test("settings.env controls pass-through and removal without changing the parent", () => {
  process.env[SECRET] = "private";
  process.env[NORMAL] = "inherited";
  expect(childEnv({ env: { [SECRET]: true, [NORMAL]: false } })[SECRET]).toBe("private");
  expect(childEnv({ env: { [SECRET]: true, [NORMAL]: false } })[NORMAL]).toBeUndefined();
  expect(childEnv({ env: { [SECRET]: false, [NORMAL]: "new" } })[SECRET]).toBeUndefined();
  expect(childEnv({ env: { [NORMAL]: true } })[NORMAL]).toBe("inherited");
  expect(childEnv({ env: { NEVER_SET: true } }).NEVER_SET).toBeUndefined();
  expect(process.env[SECRET]).toBe("private");
});

test("settings.env rejects invalid map shape and unsafe keys", () => {
  expect(() => childEnv({ env: [] })).toThrow(TypeError);
  expect(() => childEnv({ env: JSON.parse('{"__proto__":"bad"}') })).toThrow(TypeError);
  expect(() => childEnv({}, JSON.parse('{"__proto__":"bad"}'))).toThrow(TypeError);
});

test("package settings use the map policy, not legacy allow/refuse arrays", () => {
  const packageSettings = JSON.parse(readFileSync("./settings.json", "utf8"));
  expect(packageSettings["env-refuse"]).toBeUndefined();
  expect(packageSettings["env-allow"]).toBeUndefined();
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "provider-private";
  try { expect(childEnv(packageSettings).OPENAI_API_KEY).toBeUndefined(); }
  finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("foreground bash receives filtered inherited environment and policy value", async () => {
  process.env[SECRET] = "inherited-private";
  process.env[NORMAL] = "inherited-normal";
  expect(await bash({ command }, { env: { folder: process.cwd(), settings } })).toBe("absent:policy-added");
  expect(await bash({ command, env: { [SECRET]: "explicit-private" } },
    { env: { folder: process.cwd(), settings } })).toBe("explicit-private:policy-added");
});

test("background bash receives filtered environment and explicit additions", async () => {
  process.env[SECRET] = "inherited-private";
  const agent = { env: { settings }, constructor: { EVENT: { CLOSE_MARKED: "close" } }, onEvent() {} };
  try {
    const first = await backgroundStart(agent, { command, cwd: process.cwd() });
    expect(first.output).toBe("absent:policy-added");
    const second = await backgroundStart(agent, { command, cwd: process.cwd(), env: { [SECRET]: "explicit-private" } });
    expect(second.output).toBe("explicit-private:policy-added");
  } finally { stopAll(agent); }
});

test("stdio MCP receives filtered environment and configured explicit additions", async () => {
  process.env[SECRET] = "inherited-private";
  const server = resolve("./test/fixtures/mcp-server.js");
  const config = { command: process.execPath, args: [server] };
  const env = { cwd: process.cwd(), settings: { ...settings, mcp: { fixture: config } } };
  const getenv = async (registry, name) => {
    const client = await registry.connect("fixture");
    const result = await client.callTool("getenv", { name });
    return result.content[0].text;
  };
  const registry = createServers(env);
  try {
    registry.refresh();
    expect(await getenv(registry, SECRET)).toBe("");
    expect(await getenv(registry, NORMAL)).toBe("policy-added");
    env.settings.mcp = { fixture: { ...config, env: { [SECRET]: "explicit-private" } } };
    registry.refresh();
    expect(await getenv(registry, SECRET)).toBe("explicit-private");
  } finally { registry.closeAll(); }
});
