/**
 * website/lib/home.js — the landing page. Product copy mirrors the root
 * README: transparent TUI first, providers, security boundaries, then the
 * scriptable, embeddable, and browser surfaces, then jobs and sessions.
 */
import { page, wordmark } from "./html.js";
import { site } from "../site.js";

const FEATURES = [
  {
    title: "Providers are plugins",
    body: "Four provider protocols ship in the box — OpenAI Responses, Anthropic Messages, Kimi/Moonshot, and Ollama — with ready-made endpoints for OpenAI, the ChatGPT/Codex OAuth backend, GitHub Copilot, Azure OpenAI, xAI, and LM Studio. Everything normalizes into one context and event model, so switching models mid-session changes nothing else. Auto-detection reads your environment keys and probes local servers; discoveries are never persisted.",
    code: "om --login\nom --list\nom --model ollama/gpt-oss:20b",
  },
  {
    title: "Tools with enforced boundaries",
    body: "File tools refuse absolute paths and parent traversal; shell commands refuse cd/ln/ls and visible outside paths; mutating tools fork under an OS write sandbox (macOS Seatbelt, Linux Bubblewrap). No sandbox? Safe mode is forced — only read-only tools exist.",
    code: "om --safe\nom-tool --list\nom-tool read '{\"path\":\"README.md\"}'",
  },
  {
    title: "Drive it from a script",
    body: "om-agent runs the complete tool loop: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. om-io performs exactly one provider request. Stable JSONL streams, distinct exit codes per failure class, SIGINT cancellation with the partial persisted.",
    code: 'echo "Summarize this" \\\n  | om-agent \\\n    --model ollama/gpt-oss:20b',
  },
  {
    title: "Embed the library",
    body: "Zero dependencies. omoya/agent is the headless core — Agent.Context, Agent.Env, Agent.IO — with no CLI, Markdown, or UI code loaded. Import omoya/app when you want those layers.",
    code: 'import Agent from "omoya/agent";\n\nconst env = await Agent.Env.create();\nconst agent = new Agent({\n  env,\n  model: "ollama/gpt-oss:20b",\n  safe: true\n});',
  },
  {
    title: "Serve it to a browser",
    body: "om --serve starts a standalone chat SPA over HTTP and WebSocket, carrying the same Agent/Env events. The server owns the agent; the browser only renders it — close the tab and the agent keeps running. Loopback-bound, Origin-checked, no auth token: reaching the port means owning the agent.",
    code: "om --serve \\\n  --port 9900",
  },
  {
    title: "Sessions and jobs",
    body: "Named sessions persist as JSONL outside the project tree — resume, fork, roll back, or delete them. om-jobs runs scheduled, headless agent tasks written as plain Markdown files; the optional daemon is foreground-only, and cron stays yours.",
    code: "om --resume latest\nom-jobs init\nom-jobs run",
  },
];

const PRINCIPLES = [
  ["The system message is yours", "Instructions layer from three AGENTS.md files — the harness's, your settings folder's, the project's — plus anything you append live. No hidden third-party agent CLI between your instructions and the provider."],
  ["See and fix the context", "Ctrl-O opens every message, thinking block, and tool exchange in full. /context-edit corrects a message, /context-rollback rewinds, /context-system extends. The TUI always reflects the exact context the model receives."],
  ["The web, without an account", "web-search and web-fetch route the provider's own backend, then a mapped MCP server, then a package backend aggregating SearXNG, DuckDuckGo, Mojeek, and Brave — bounded, cached, rate-limited."],
  ["The project is the unit of memory", "ai-settings.json, ai-auth-*.json, ai-skills/, ai-prompts/, ai-jobs/, AGENTS.md — what an agent learns stays in the folder it learned it in, invisible from any other project."],
  ["Direct tool access", "om-tool lists and calls any tool without an agent; om-skills prints the skill catalog; om-tools2bash generates direct shell wrappers. Direct calls are the manual door: interactive tools need an agent's question bridge, and mutating calls here run without the OS sandbox."],
  ["Rename the whole harness", "lib/namespace.js is the single switch for runtime identity; bin/scripts/rename rewrites env vars, the settings folder, and every executable in one step. The project-local ai- prefix is the deliberate constant."],
];

export function homePage() {
  return page({
    title: site.title,
    description: site.description,
    path: "/",
    body: `<section class="hero">
  <div class="hero-brand">
    <img src="./assets/logo.svg" width="160" height="160" alt="">
    <div>
      <p class="eyebrow">TRANSPARENT BUN AGENT HARNESS</p>
      <h1><span class="product-name">${wordmark("Omoya")}</span><span class="hero-claim">See what your agent sees.</span></h1>
    </div>
  </div>
  <p class="lede">Most agent tools hide the context, rewrite your files, and lock you to one vendor. Omoya shows you exactly what the model sees. Filesystem boundaries are enforced by the OS, not by prompt instructions. Every shipped provider — and OpenAI-/Anthropic-compatible third-party endpoints — normalizes into one event model. Zero dependencies; requires only <a href="https://bun.sh/">Bun</a>.</p>
  <div class="actions"><a class="button" href="https://www.npmjs.com/package/omoya">Install from npm</a><a class="text-link" href="${site.repository}">View the source on GitHub →</a></div>
  <pre><code>bunx omoya --login     # no install needed
bunx omoya             # start the terminal interface

om --model ollama/gpt-oss:20b   # or a local model — no account at all</code></pre>
</section>
<section aria-labelledby="why-heading">
  <h2 id="why-heading">Why Omoya</h2>
  <p><strong>Stop context leaks</strong> — where other agent tools stop at a project instructions file, Omoya makes the project the unit of everything: skills, prompts, settings, and scheduled jobs live in <code>ai-</code> files inside the folder they belong to, minimizing cross-project context leaks.</p>
  <p><strong>Project memory and workflow</strong> — Omoya's <code>core</code> skill encodes working conventions (memory files, task ledgers, delegation rules), leading to context-aware agents using practical conventions.</p>
  <p><strong>Transparency</strong> — inspect and edit the exact context the model receives, watch every tool call, read the unified diff of every edit.</p>
  <p><strong>Convention over configuration</strong> — auto-detection for local Ollama / LM Studio models, SearXNG (<code>SEARXNG_URL</code>), and known endpoints (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, etc.) — zero-configuration functionality.</p>
</section>
<section aria-labelledby="tui-heading">
  <h2 id="tui-heading">A terminal interface that hides nothing</h2>
  <p><code>om</code> streams responses and thinking as they arrive, shows every tool call as it happens, and keeps the whole conversation open for inspection and correction. <strong>Ctrl-O</strong> opens any block in full; <strong>Ctrl-C</strong> cancels a runaway response and keeps the partial output; <code>/context-edit</code> and <code>/context-rollback</code> rewrite the exact context the model receives. Multi-line input, paste handling, completion, themes, and queued follow-ups are built in.</p>
</section>
<section aria-labelledby="surfaces-heading">
  <h2 id="surfaces-heading">One core, every surface</h2>
  <div class="grid features">
${FEATURES.map((f) => `    <article class="card"><h3>${f.title}</h3><p>${f.body}</p><pre><code>${f.code}</code></pre></article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="principles-heading">
  <h2 id="principles-heading">Owned by you, visible to you</h2>
  <div class="grid">
${PRINCIPLES.map(([title, body]) => `    <article class="card"><h3>${title}</h3><p>${body}</p></article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="security-heading">
  <h2 id="security-heading">Security, with the honest limits stated</h2>
  <p>The current working folder <strong>is</strong> the agent's root, enforced in layers — not by prompt instructions alone:</p>
  <ul>
    <li>File tools accept only relative paths inside the working folder; <code>read</code> rejects symbolic links.</li>
    <li>Mutating tools fork under an OS write sandbox — macOS Seatbelt or Linux Bubblewrap — mounting only the working folder as writable. With no sandbox, the agent <strong>forces safe mode</strong>.</li>
    <li>Session logs live outside the project tree, so cwd-scoped tools can never rewrite their own history; tool schemas never carry security metadata.</li>
    <li><strong>Honest limit:</strong> the sandbox confines writes, not reads. A shell command can follow a pre-existing symlink — do not run the agent in a tree containing untrusted symlinks. See <a href="${site.repository}/blob/main/SECURITY.md">SECURITY.md</a>.</li>
  </ul>
</section>
<section aria-labelledby="environment-heading">
  <h2 id="environment-heading">Zero-config provider detection</h2>
  <p>At startup Omoya reads the process environment and probes local servers. Discoveries are <strong>dynamic</strong> — in memory only, re-detected every startup; remove a key or stop a server and nothing is left behind.</p>
  <table>
    <thead><tr><th>environment</th><th>detected endpoint</th></tr></thead>
    <tbody>
      <tr><td><code>OPENAI_API_KEY</code> (+ optional <code>OPENAI_BASE_URL</code>)</td><td><code>openai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code></td><td><code>anthropic</code> (Anthropic Messages)</td></tr>
      <tr><td><code>MOONSHOT_API_KEY</code> (+ optional <code>MOONSHOT_BASE_URL</code>)</td><td><code>kimi</code> (Moonshot platform)</td></tr>
      <tr><td><code>KIMI_API_KEY</code></td><td><code>kimi-coding</code> (Kimi for Coding relay)</td></tr>
      <tr><td><code>XAI_API_KEY</code></td><td><code>xai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>AZURE_OPENAI_API_KEY</code> (+ required <code>AZURE_OPENAI_BASE_URL</code>)</td><td><code>azure-openai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>localhost:11434</code> probe (Ollama <code>/api/tags</code>)</td><td><code>ollama</code></td></tr>
      <tr><td><code>localhost:1234</code> probe (LM Studio <code>/v1/models</code>)</td><td><code>lm-studio</code> (OpenAI-compatible)</td></tr>
    </tbody>
  </table>
  <p>The <code>web-search</code> tool likewise auto-detects a local SearXNG instance (<code>SEARXNG_URL</code>/<code>SEARXNG_BASE</code>) and enables Brave when <code>BRAVE_API_KEY</code> is set; see the <a href="/api/tools/#web-search">tool catalog</a> for the provider → MCP → package routing.</p>
</section>
<section aria-labelledby="start-heading">
  <h2 id="start-heading">Start in one minute</h2>
  <pre><code>bunx omoya --login      # configure an endpoint, no install needed
bunx omoya              # start the terminal interface

om --list               # then explore: the available models
om-tool --list          # every tool, no agent needed</code></pre>
  <p>Every shipped command — <code>omoya</code>, <code>om</code>, <code>om-agent</code>, <code>om-io</code>, <code>om-tool</code>, <code>om-skills</code>, <code>om-jobs</code>, <code>om-tools2bash</code> (plus the <code>om-app</code>, <code>skills</code>, and <code>tools2bash</code> aliases) — has built-in <code>--help</code>. The full API is documented in the <a href="./api">generated reference</a>.</p>
</section>`,
  });
}
