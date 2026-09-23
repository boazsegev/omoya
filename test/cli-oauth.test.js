// test/cli-oauth.test.js — proof for the browser sign-in flow: PKCE,
// the authorize URL, paste parsing, token mapping, and the loopback +
// paste fallback of runOAuthFlow against a stub token endpoint.
import { describe, expect, test } from "bun:test";
import {
  generatePKCE, authorizeUrl, parseAuthorizationInput, tokensToAuth,
  runOAuthFlow, completeOAuthPaste, oauthPasteOnly, refreshOAuthTokens,
} from "../lib/cli/oauth.js";

const DESCRIPTOR = {
  label: "Test OAuth",
  clientId: "client-1",
  authorizeUrl: "https://provider.test/oauth/authorize",
  tokenUrl: "http://127.0.0.1:1/token", // overridden per test
  redirectUri: "http://localhost:18993/auth/callback",
  scope: "openid profile",
  extraAuthorizeParams: { originator: "ai-agent" },
};

describe("PKCE + authorize URL", () => {
  test("verifier/challenge are base64url; the challenge is the S256 of the verifier", async () => {
    const { verifier, challenge } = generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(verifier).digest()
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  test("the authorize URL carries client, redirect, scope, state, PKCE, and extras", () => {
    const url = new URL(authorizeUrl(DESCRIPTOR, { state: "s1", challenge: "c1" }));
    expect(url.origin + url.pathname).toBe("https://provider.test/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(DESCRIPTOR.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("code_challenge")).toBe("c1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("originator")).toBe("ai-agent");
  });
});

describe("parseAuthorizationInput (headless paste)", () => {
  test("a full redirect URL, code#state, and a bare code", () => {
    expect(parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=xyz"))
      .toEqual({ code: "abc", state: "xyz" });
    expect(parseAuthorizationInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
    expect(parseAuthorizationInput("abc")).toEqual({ code: "abc" });
    expect(parseAuthorizationInput("  ")).toEqual({});
  });
});

describe("tokensToAuth", () => {
  test("access mirrors into token; refresh and expiry ride along", () => {
    const auth = tokensToAuth({ access_token: "a-1", refresh_token: "r-1", expires_in: 3600 });
    expect(auth.type).toBe("oauth");
    expect(auth.access).toBe("a-1");
    expect(auth.token).toBe("a-1"); // the wire layer's bearer auth, unchanged
    expect(auth.refresh).toBe("r-1");
    expect(auth.expires).toBeGreaterThan(Date.now());
    expect(() => tokensToAuth({})).toThrow(/access_token/);
  });
});

describe("OAuth token refresh", () => {
  test("exchanges a refresh token and retains it when the server omits a replacement", async () => {
    const server = Bun.serve({ port: 0, fetch: async (request) => {
      const body = await request.text();
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=old-refresh");
      return Response.json({ access_token: "new-access", expires_in: 60 });
    } });
    try {
      const tokens = await refreshOAuthTokens({ tokenUrl: server.url.toString(), clientId: "client" }, "old-refresh");
      expect(tokensToAuth(tokens, { refresh: "old-refresh" })).toMatchObject({
        type: "oauth", token: "new-access", access: "new-access", refresh: "old-refresh",
      });
    } finally { server.stop(true); }
  });
});

describe("runOAuthFlow", () => {
  /** A stub token endpoint + the flow descriptor pointing at it. */
  const tokenServer = (handler) => {
    const server = Bun.serve({ port: 0, fetch: handler });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };

  test("browser path: the loopback callback completes the sign-in and exchanges the code", async () => {
    const seen = {};
    const stub = tokenServer(async (req) => {
      seen.body = await req.text();
      return Response.json({ access_token: "a-loop", refresh_token: "r-loop", expires_in: 60 });
    });
    let authUrl = null;
    const flow = runOAuthFlow(
      { ...DESCRIPTOR, tokenUrl: `${stub.url}/token` },
      { open: (url) => { authUrl = url; return true; }, onLog: () => {} },
    );
    await Bun.sleep(60); // the loopback listener binds
    const state = new URL(authUrl).searchParams.get("state");
    const response = await fetch(`http://127.0.0.1:18993/auth/callback?code=code-1&state=${state}`);
    expect(response.status).toBe(200);
    const tokens = await flow;
    stub.stop();
    expect(tokens.access_token).toBe("a-loop");
    const form = new URLSearchParams(seen.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("code_verifier")).toBeTruthy();
  });

  test("paste fallback: completeOAuthPaste feeds the redirect (headless)", async () => {
    const stub = tokenServer(() => Response.json({ access_token: "a-paste" }));
    let authUrl = null;
    const flow = runOAuthFlow(
      { ...DESCRIPTOR, tokenUrl: `${stub.url}/token` },
      { open: (url) => { authUrl = url; return false; }, onLog: () => {} },
    );
    await Bun.sleep(60);
    const state = new URL(authUrl).searchParams.get("state");
    expect(completeOAuthPaste(`http://localhost:18993/auth/callback?code=code-2&state=${state}`)).toBe(true);
    const tokens = await flow;
    stub.stop();
    expect(tokens.access_token).toBe("a-paste");
    expect(completeOAuthPaste("anything")).toBe(false); // no flow in flight
  });

  test("a state mismatch fails the sign-in", async () => {
    const stub = tokenServer(() => Response.json({ access_token: "unused" }));
    const flow = runOAuthFlow(
      { ...DESCRIPTOR, tokenUrl: `${stub.url}/token` },
      { open: () => true, onLog: () => {} },
    );
    await Bun.sleep(60);
    completeOAuthPaste("code-3#wrong-state");
    await expect(flow).rejects.toThrow(/state mismatch/);
    stub.stop();
  });
});

describe("runOAuthFlow — the DEVICE flow (RFC 8628, grant shape B)", () => {
  const deviceServer = (handler) => {
    const server = Bun.serve({ port: 0, fetch: handler });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };
  const deviceDescriptor = (base) => ({
    label: "Test Device Sign-in",
    clientId: "client-9",
    deviceAuthorizationUrl: `${base}/device_authorization`,
    tokenUrl: `${base}/token`,
    pollInterval: 0.01, // tests can't wait 5s a poll
  });

  test("pending then approved: the verification URL opens, the poll returns tokens", async () => {
    const seen = { polls: 0, forms: [] };
    const stub = deviceServer(async (req) => {
      const form = new URLSearchParams(await req.text());
      seen.forms.push(form);
      if (req.url.endsWith("/device_authorization")) {
        return Response.json({
          device_code: "dev-1", user_code: "ABCD-EFGH",
          verification_uri: "https://example.test/device",
          verification_uri_complete: "https://example.test/device?code=ABCD-EFGH",
          interval: 0.01, expires_in: 60,
        });
      }
      seen.polls++;
      if (seen.polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "a-device", refresh_token: "r-device", expires_in: 300 });
    });
    let authUrl = null;
    const logs = [];
    const tokens = await runOAuthFlow(deviceDescriptor(stub.url), {
      open: (url) => { authUrl = url; return true; },
      onLog: (line) => logs.push(line),
    });
    stub.stop();
    expect(tokens.access_token).toBe("a-device");
    expect(authUrl).toBe("https://example.test/device?code=ABCD-EFGH"); // the complete URI opens
    expect(logs.join("\n")).toContain("ABCD-EFGH"); // the user code is narrated
    const auth = seen.forms[0];
    expect(auth.get("client_id")).toBe("client-9");
    const poll = seen.forms.at(-1);
    expect(poll.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(poll.get("device_code")).toBe("dev-1");
    expect(seen.polls).toBe(2); // one pending, one complete
  });

  test("slow_down backs off; access_denied and a bad start fail clearly", async () => {
    const stub = deviceServer(async (req) => {
      if (req.url.endsWith("/device_authorization")) {
        return Response.json({
          device_code: "dev-2", user_code: "XX",
          verification_uri: "https://example.test/v", interval: 0.01, expires_in: 60,
        });
      }
      return Response.json({ error: "access_denied" }, { status: 400 });
    });
    await expect(runOAuthFlow(deviceDescriptor(stub.url), { open: () => false, onLog: () => {} }))
      .rejects.toThrow(/denied/);
    stub.stop();

    const bad = deviceServer(() => Response.json({ nope: true }, { status: 400 }));
    await expect(runOAuthFlow(deviceDescriptor(bad.url), { open: () => false, onLog: () => {} }))
      .rejects.toThrow(/device authorization failed/);
    bad.stop();
  });

  test("expired_token and slow_down handling", async () => {
    let polls = 0;
    const stub = deviceServer(async (req) => {
      if (req.url.endsWith("/device_authorization")) {
        return Response.json({
          device_code: "dev-3", user_code: "YY",
          verification_uri: "https://example.test/v", interval: 0.01, expires_in: 60,
        });
      }
      polls++;
      if (polls === 1) return Response.json({ error: "slow_down", interval: 0.01 }, { status: 400 });
      return Response.json({ error: "expired_token" }, { status: 400 });
    });
    await expect(runOAuthFlow(deviceDescriptor(stub.url), { open: () => false, onLog: () => {} }))
      .rejects.toThrow(/expired/);
    stub.stop();
    expect(polls).toBe(2); // slow_down kept polling, expired_token ended it
  });
});

describe("runOAuthFlow — descriptor knobs the helper adapts to (the Claude subscription shape)", () => {
  const tokenServer = (handler) => {
    const server = Bun.serve({ port: 0, fetch: handler });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };

  test("oauthPasteOnly: a non-loopback redirect is paste-only; loopback and device flows are not", () => {
    expect(oauthPasteOnly(DESCRIPTOR)).toBe(false);
    expect(oauthPasteOnly({ ...DESCRIPTOR, redirectUri: "http://127.0.0.1:1455/cb" })).toBe(false);
    expect(oauthPasteOnly({ ...DESCRIPTOR, redirectUri: "http://[::1]:1455/cb" })).toBe(false);
    expect(oauthPasteOnly({ ...DESCRIPTOR, redirectUri: "https://console.provider.test/oauth/code/callback" })).toBe(true);
    expect(oauthPasteOnly({ clientId: "c", deviceAuthorizationUrl: "https://x/device", tokenUrl: "https://x/token" })).toBe(false);
    expect(oauthPasteOnly(undefined)).toBe(false);
  });

  test("paste-only + JSON exchange carrying the state: no listener opens, code#state completes it", async () => {
    const seen = {};
    const stub = tokenServer(async (req) => {
      seen.contentType = req.headers.get("content-type");
      seen.body = await req.json();
      return Response.json({ access_token: "a-json", refresh_token: "r-json", expires_in: 3600 });
    });
    const logs = [];
    let authUrl = null;
    const flow = runOAuthFlow({
      ...DESCRIPTOR,
      tokenUrl: `${stub.url}/token`,
      redirectUri: "https://console.provider.test/oauth/code/callback", // hosted: shows the code
      extraAuthorizeParams: { code: "true" },
      tokenFormat: "json",
      tokenIncludesState: true,
    }, { open: (url) => { authUrl = url; return true; }, onLog: (l) => logs.push(l) });
    await Bun.sleep(20);
    const state = new URL(authUrl).searchParams.get("state");
    expect(new URL(authUrl).searchParams.get("code")).toBe("true"); // the extra authorize param
    expect(logs.some((l) => /paste what the sign-in page shows/.test(l))).toBe(true);
    // nothing listens on a loopback port: the paste IS the channel
    expect(completeOAuthPaste(`code-json#${state}`)).toBe(true);
    const tokens = await flow;
    stub.stop();
    expect(tokens.access_token).toBe("a-json");
    expect(seen.contentType).toMatch(/application\/json/);
    expect(seen.body).toEqual({
      grant_type: "authorization_code",
      code: "code-json",
      state,
      redirect_uri: "https://console.provider.test/oauth/code/callback",
      client_id: "client-1",
      code_verifier: expect.any(String),
    });
  });

  test("the default form exchange never carries the state (unchanged contract)", async () => {
    const seen = {};
    const stub = tokenServer(async (req) => {
      seen.body = await req.text();
      return Response.json({ access_token: "a-form" });
    });
    let authUrl = null;
    const flow = runOAuthFlow(
      { ...DESCRIPTOR, tokenUrl: `${stub.url}/token` },
      { open: (url) => { authUrl = url; return false; }, onLog: () => {} },
    );
    await Bun.sleep(60);
    const state = new URL(authUrl).searchParams.get("state");
    completeOAuthPaste(`code-4#${state}`);
    await flow;
    stub.stop();
    expect(new URLSearchParams(seen.body).get("state")).toBeNull();
  });
});
