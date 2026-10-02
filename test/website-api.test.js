import { test, expect } from "bun:test";
import { collect } from "./api-reference.js";
import { apiPages } from "../website/lib/api.js";
import { homePage } from "../website/lib/home.js";
import { settingsSchemaValues } from "./api-schema.js";

test("architecture environment detection links to the public startup API", async () => {
  const pages = apiPages(await collect());
  const architecture = pages.find((page) => page.path === "/api/architecture/").html;
  const env = pages.find((page) => page.path === "/api/env/").html;
  expect(architecture).toContain('href="/api/env/#Env-create"');
  expect(architecture).toContain('<code>Env.create()</code>');
  expect(env).toContain('id="Env-create"');
  expect(architecture).not.toContain("Env-endpointsDetect");
});

test("external Bun and SearXNG links open in a separate tab safely", () => {
  const html = homePage();
  for (const url of ["https://bun.sh/", "https://docs.searxng.org/"]) {
    expect(html).toContain(`href="${url}" target="_blank" rel="noopener noreferrer"`);
  }
});

test("each API reference section expands with working sidebar anchors", async () => {
  const pages = apiPages(await collect());
  for (const path of ["/api/architecture/", "/api/contracts/", "/api/tools/", "/api/settings/"]) {
    const html = pages.find((page) => page.path === path).html;
    const nav = html.split('<nav class="api-nav"')[1].split('</nav>')[0];
    const current = nav.split('class="current"')[1].split('</li>')[0];
    const anchors = [...current.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(html).toContain(`id="${anchor}"`);
  }
});

test("website settings render the same inferred contract as API-schema.md", async () => {
  const data = await collect();
  const values = settingsSchemaValues(data);
  const html = apiPages(data).find((page) => page.path === "/api/settings/").html;
  expect(values.tui.cursor.blink).toBe("number");
  expect(values.mcp["<server>"].args).toBe("string[]");
  expect(html).toContain('&quot;blink&quot;: &quot;number&quot;');
  expect(html).toContain('&quot;&lt;server&gt;&quot;');
  expect(html).toContain('&quot;args&quot;: &quot;string[]&quot;');
});
