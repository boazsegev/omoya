/**
 * website/lib/home.js — the landing page. Product copy reflects the root
 * README: terminal interface, headless/streaming use, embeddable library,
 * browser serving, sessions, providers, tools, jobs, security boundaries.
 */
import { page, wordmark } from "./html.js";
import { site } from "../site.js";

const FEATURES = [
  {
    title: "The terminal interface",
    body: "A long-running TUI that streams responses and thinking, shows tool activity as it happens, and keeps the current context inspectable and editable — menus, questionnaires, multi-line input, completion, themes, and queued follow-ups included.",
    code: "om\nom --resume latest\nom --safe",
  },
  {
    title: "Drive it from a script",
    body: "om-agent runs the complete tool loop without the TUI: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. om-io performs exactly one provider request — stable streams, distinct exit codes, real cancellation.",
    code: 'echo "Summarize this" \\\n  | om-agent \\\n    --model ollama/gpt-oss:20b',
  },
  {
    title: "Embed the library",
    body: "lib/agent.js is the headless core entry point, publishing Agent.Context, Agent.Env, and Agent.IO. Import omoya/app when CLI, Markdown, and UI concerns are needed — headless applications stay free of the interface graph.",
    code: 'import Agent from "omoya/agent";\n\nconst env = await Agent.Env.create();\nconst agent = new Agent({\n  env, model: "ollama/gpt-oss:20b"\n});',
  },
  {
    title: "Serve it to a browser",
    body: "om --serve starts a standalone chat SPA over HTTP with a WebSocket carrying the same Agent/Env events used everywhere else. The server owns the agent; the browser only renders it. Loopback-bound by default.",
    code: "om --serve \\\n  --port 9900",
  },
  {
    title: "Sessions that outlive the UI",
    body: "Named sessions persist as JSONL under the user settings directory, outside the working project. Resume, rename, edit, roll back, fork, or delete them — anonymous sessions write nothing.",
    code: "om --resume latest",
  },
  {
    title: "Project jobs, under your control",
    body: "om-jobs runs project-local Markdown tasks by explicit init/run/disable. Manual run is primary; an optional daemon scans immediately and then five minutes after each child completes. Cron and restart policy stay yours: use an explicit runtime, wrapper, and project cwd.",
    code: "om-jobs init\nom-jobs run\nom-jobs daemon \\\n  foreground",
  },
];

const PRINCIPLES = [
  ["Transparent by default", "See what the model sees. Inspect the context, interrupt work, change course, and keep filesystem operations rooted in the current project. No hidden third-party CLI between your instructions and the provider."],
  ["Tools with boundaries", "Scoped file tools, bounded shell commands, MCP servers, skills, notes, and child workers — all composable, with read-only safe mode and an OS write sandbox for mutating tools. Security metadata never reaches the model."],
  ["Providers are plugins", "OpenAI Responses-compatible endpoints (including ChatGPT/Codex OAuth), Anthropic Messages, GitHub Copilot, Kimi/Moonshot, and Ollama — normalized into one context and event model. Switch models without leaving the TUI."],
  ["Zero-config local discovery", "Endpoint auto-detection finds what's already running: an Ollama server on localhost:11434 (and LM Studio on 1234) becomes a ready endpoint with no setup, and a local SearXNG instance (SEARXNG_URL/SEARXNG_BASE) becomes the web-search backend. Discoveries are dynamic — never persisted, re-detected every startup."],
  ["The web, without an account", "Every web-search and web-fetch call routes the provider's web backend, then a mapped MCP server, then a package backend that needs no account: SearXNG instances are tried first (SEARXNG_URL/SEARXNG_BASE or web.search.backends), then DuckDuckGo and Mojeek are aggregated with rank fusion — Brave joins when BRAVE_API_KEY is set, Swisscows is opt-in, and web-fetch converts pages to Markdown. All of it is bounded, cached, and rate-limited."],
  ["The project is the unit of memory", "What an agent learns belongs to the project folder it learned it in: ai-settings.json, ai-skills/, ai-prompts/, ai-jobs/, AGENTS.md. Open a different folder and the agent starts from package defaults."],
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
  <p class="lede">Omoya puts the whole agent loop in your hands — model selection, system instructions, context, tools, sessions, and security policy. Work in the terminal, stream structured events through a headless process, or embed the Bun library in your own project.</p>
  <div class="actions"><a class="button" href="https://www.npmjs.com/package/omoya">Install from npm</a><a class="text-link" href="${site.repository}">View the source on GitHub →</a></div>
  <pre><code>bun add -g omoya
omoya --login
om</code></pre>
</section>
<section aria-labelledby="surfaces-heading">
  <h2 id="surfaces-heading">One core, every surface</h2>
  <div class="grid features">
${FEATURES.map((f) => `    <article class="card"><h3>${f.title}</h3><p>${f.body}</p><pre><code>${f.code}</code></pre></article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="principles-heading">
  <h2 id="principles-heading">What makes it useful</h2>
  <div class="grid">
${PRINCIPLES.map(([title, body]) => `    <article class="card"><h3>${title}</h3><p>${body}</p></article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="security-heading">
  <h2 id="security-heading">Filesystem security, enforced</h2>
  <p>The current working folder <strong>is</strong> the agent's root — enforced in layers, not by prompt instructions alone:</p>
  <ul>
    <li>File tools accept only relative paths inside the working folder; absolute paths and parent traversal are refused, and <code>read</code> rejects symbolic links.</li>
    <li>Shell commands refuse <code>cd</code>, <code>ln</code>, <code>ls</code>, and visible arguments pointing outside the working folder.</li>
    <li>Mutating tools fork under an OS write sandbox — macOS Seatbelt or Linux Bubblewrap — mounting only the working folder as writable.</li>
    <li>With no supported sandbox, the agent <strong>forces safe mode</strong>: only read-only tools exist. <code>--safe</code> selects the same posture at any time.</li>
    <li>Session logs live outside the project tree, so cwd-scoped tools can never rewrite their own history.</li>
  </ul>
  <p>Reads are not fully sandboxed by design: do not run the agent in a tree containing untrusted symlinks, and do not rely on <code>bash</code> to protect secrets outside that tree.</p>
</section>
<section aria-labelledby="environment-heading">
  <h2 id="environment-heading">Environment auto-detection</h2>
  <p>Endpoint auto-detection reads the process environment and probes local servers at startup. Discoveries are <strong>dynamic</strong> — in memory only, never persisted, re-detected every startup; a key or server removed from the environment leaves nothing behind.</p>
  <table>
    <thead><tr><th>environment</th><th>detected endpoint</th></tr></thead>
    <tbody>
      <tr><td><code>OPENAI_API_KEY</code> (+ optional <code>OPENAI_BASE_URL</code>)</td><td><code>openai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>AZURE_OPENAI_API_KEY</code> (+ required <code>AZURE_OPENAI_BASE_URL</code>)</td><td><code>azure-openai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>XAI_API_KEY</code></td><td><code>xai</code> (OpenAI Responses)</td></tr>
      <tr><td><code>MOONSHOT_API_KEY</code> (+ optional <code>MOONSHOT_BASE_URL</code>)</td><td><code>kimi</code> (Moonshot platform)</td></tr>
      <tr><td><code>KIMI_API_KEY</code></td><td><code>kimi-coding</code> (Kimi for Coding relay)</td></tr>
      <tr><td><code>ANTHROPIC_API_KEY</code> or <code>ANTHROPIC_AUTH_TOKEN</code> (+ optional <code>ANTHROPIC_BASE_URL</code>)</td><td><code>anthropic</code> (Anthropic Messages)</td></tr>
      <tr><td><code>http://localhost:11434</code> — Ollama server probe (<code>/api/tags</code>)</td><td><code>ollama</code></td></tr>
      <tr><td><code>http://localhost:1234/v1</code> — LM Studio server probe (<code>/models</code>)</td><td><code>lm-studio</code> (OpenAI-compatible)</td></tr>
    </tbody>
  </table>
  <p>The harness itself reads a small namespace-derived set: <code>OMOYA_SETTINGS_DIR</code> (settings folder override, with the legacy <code>AI_SETTINGS_DIR</code>/<code>OMOYA_SETTINGS</code>/<code>AI_SETTINGS</code> spellings), <code>OMOYA_SKILLS_DIR</code> and <code>OMOYA_PROMPTS_DIR</code> (extra catalog roots), and <code>OMOYA_OS_SANDBOX=none</code> (disable the write-sandbox probe — the Agent then forces safe mode). The <code>web-search</code> tool reads <code>SEARXNG_URL</code>/<code>SEARXNG_BASE</code> (auto-detected as its SearXNG backend — a local instance needs no API key) and <code>BRAVE_API_KEY</code> (enables the Brave search engine — without it Brave stays off); see the <a href="/api/tools/#web-search">tool catalog</a> for the provider → MCP → package routing.</p>
</section>
<section aria-labelledby="start-heading">
  <h2 id="start-heading">Start in one minute</h2>
  <pre><code>bunx omoya --help          # run without installing
om --model ollama/gpt-oss:20b   # or point at a local model
om-tool --list             # run tools directly, no agent</code></pre>
  <p>Requires <a href="https://bun.sh/">Bun</a>. Every shipped command — <code>omoya</code>, <code>om</code>, <code>om-agent</code>, <code>om-io</code>, <code>om-tool</code>, <code>om-skills</code>, <code>om-jobs</code> — has built-in <code>--help</code>.</p>
</section>`,
  });
}
