/**
 * website/lib/home.js — the landing page. Answer first: claim, install,
 * an annotated command walkthrough, then why, surfaces, security, provider
 * detection, principles, and a closing call to action.
 *
 * Facts rule: every product statement here restates the root README.md —
 * do not add claims the README does not make. Every command shown is
 * runnable as printed, and no command output is invented.
 */
import { escapeHtml, page } from "./html.js";
import { site } from "../site.js";

/** Install methods (README "Try it now"), shown as tabs (stacked without JS). */
const INSTALL = [
  { id: "bunx", label: "bunx", note: "no install", code: "bunx omoya --login\nbunx omoya" },
  { id: "bun", label: "bun add", note: "global", code: "bun add -g omoya\nom --login" },
  { id: "source", label: "source", note: "checkout", code: `git clone ${site.repository}.git\ncd omoya && bun bin/om --login` },
];

/** The hero terminal: README commands, annotated with README facts — typed in on first view. */
const WALKTHROUGH = [
  ["om --login", "configure an endpoint (OAuth, token, or local)"],
  ["om --list", "print the available models"],
  ["om --model ollama/gpt-oss:20b", "a local Ollama model needs no account"],
  ["om --safe", "only read-only tools exist"],
  ['echo "Summarize this project" | om-agent', "normalized JSONL events on stdout"],
  ["om --serve --port 9900", "a chat SPA over HTTP and WebSocket"],
];

const WHY = [
  ["Stop context leaks", "Where other agent tools stop at a project instructions file, Omoya makes the project the unit of everything: skills, prompts, settings, and scheduled jobs live in <code>ai-</code> files inside the folder they belong to."],
  ["Project memory and workflow", "The <code>core</code> skill encodes working conventions — memory files, task ledgers, delegation rules — leading to context-aware agents using practical conventions."],
  ["Transparency", "Inspect and edit the exact context the model receives, watch every tool call, read the unified diff of every edit."],
  ["Convention over configuration", "Auto-detection for local Ollama / LM Studio models, SearXNG (<code>SEARXNG_URL</code>), and known endpoints (<code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, etc.) — zero-configuration functionality."],
];

const SURFACES = [
  {
    kicker: "Terminal",
    title: "An interface that hides nothing",
    body: "<code>om</code> streams responses and thinking as they arrive, shows every tool call as it happens, and keeps the whole conversation open for inspection and correction. <kbd>Ctrl-O</kbd> opens the full text of any message, thinking, or tool exchange; <kbd>Ctrl-C</kbd> cancels a runaway response and keeps the partial output; <code>/context-edit</code>, <code>/context-rollback</code>, and <code>/context-system</code> correct, rewind, or extend the exact context the model receives.",
    code: "om --resume latest   # pick up where you left off\nom --help            # the complete key and command guide",
  },
  {
    kicker: "Providers",
    title: "Providers are plugins",
    body: "Four provider protocols ship out of the box — OpenAI Responses, Anthropic Messages, Kimi/Moonshot, and Ollama — with ready-made endpoints for OpenAI, the ChatGPT/Codex OAuth backend, GitHub Copilot, Azure OpenAI, xAI, and LM Studio. Every provider normalizes into one context and event model, so switching models — even mid-session — changes nothing else.",
    code: "om --login\nom --list\nom --model ollama/gpt-oss:20b",
  },
  {
    kicker: "Scripts",
    title: "Drive it from a script",
    body: "<code>om-agent</code> runs the complete tool loop without the TUI: one context in on stdin, normalized JSONL events out on stdout, diagnostics on stderr. <code>om-io</code> performs exactly one provider request with no autonomous tool execution. Both exit distinctly per failure class and cancel on <kbd>SIGINT</kbd> — the partial response is persisted, exit 130.",
    code: 'echo "Summarize this project" \\\n  | om-agent --model ollama/gpt-oss:20b\n\necho "Hello" \\\n  | om-io --model anthropic/claude-sonnet-5',
  },
  {
    kicker: "Library",
    title: "Embed the library",
    body: "<code>omoya/agent</code> is the headless core — it publishes <code>Agent.Context</code>, <code>Agent.Env</code>, and <code>Agent.IO</code> without loading any CLI, Markdown, or UI code. Import <code>omoya/app</code> when you want those layers.",
    code: 'import Agent from "omoya/agent";\n\nconst env = await Agent.Env.create();\nconst agent = new Agent({\n  env, model: "ollama/gpt-oss:20b", safe: true,\n});',
  },
  {
    kicker: "Browser",
    title: "Serve it to a browser",
    body: "A standalone chat SPA over HTTP and WebSocket, carrying the same Agent/Env events used everywhere else. The server owns the agent; closing the tab detaches the view while the agent keeps running. It binds to loopback and checks the WebSocket Origin header. There is no auth token: <strong>reaching the port means owning the agent</strong>.",
    code: "om --serve --port 9900",
  },
  {
    kicker: "Sessions & jobs",
    title: "Sessions and jobs",
    body: "Named sessions persist as JSONL under the user settings directory: resume, rename, edit, roll back, fork, or delete them; anonymous sessions write nothing. <code>om-jobs</code> runs scheduled, headless agent tasks defined as plain Markdown files under <code>ai-jobs/tasks/</code>; wire periodic runs into your own cron or service manager.",
    code: "om-jobs init     # create ai-jobs/ (idempotent)\nom-jobs run      # one best-effort scan, executes due tasks",
  },
];

const SECURITY = [
  "File tools refuse absolute paths and parent traversal; <code>read</code> rejects symbolic links.",
  "<code>bash</code> refuses <code>cd</code>, <code>ln</code>, and visible outside paths.",
  "Mutating tools fork under an OS write sandbox (macOS Seatbelt, Linux Bubblewrap). With no sandbox available, <strong>safe mode is forced</strong>: only read-only tools exist.",
  "Session logs live outside the project tree, so cwd-scoped tools cannot rewrite their own history.",
  "A package-shipped refusal list strips provider API keys from spawned child processes.",
];

const DETECTED = [
  ["<code>OPENAI_API_KEY</code>", "<code>openai</code>"],
  ["<code>ANTHROPIC_API_KEY</code>", "<code>anthropic</code>"],
  ["<code>MOONSHOT_API_KEY</code>", "<code>kimi</code>"],
  ["<code>KIMI_API_KEY</code>", "<code>kimi-coding</code>"],
  ["<code>XAI_API_KEY</code>", "<code>xai</code>"],
  ["<code>AZURE_OPENAI_API_KEY</code> + <code>AZURE_OPENAI_BASE_URL</code>", "<code>azure-openai</code>"],
  ["Ollama running on <code>localhost:11434</code>", "<code>ollama</code>"],
  ["LM Studio running on <code>localhost:1234</code>", "<code>lm-studio</code>"],
];

const PRINCIPLES = [
  ["The system message is yours", "Fresh sessions layer instructions from three <code>AGENTS.md</code> files — the harness's own, your user settings folder's, and the working project's — plus <code>settings.system</code> and anything you append live. There is no hidden third-party agent CLI between your instructions and the model provider."],
  ["The project is the unit of memory", "<code>ai-settings.json</code>, <code>ai-auth-*.json</code>, <code>ai-skills/</code>, <code>ai-prompts/</code>, <code>ai-jobs/</code>, <code>AGENTS.md</code> — none of it is visible from another project. The <code>ai-</code> prefix never changes, even if the harness is renamed."],
  ["The web, without an account", "Web search and fetch route through the provider's own web backend, then a mapped MCP server, then a package backend — bounded, cached, and rate-limited. The package backend tries SearXNG first, then DuckDuckGo and Mojeek; <code>BRAVE_API_KEY</code> adds Brave."],
  ["Direct tool access", "Run any installed Omoya tool directly, no agent required: <code>om-tool --list</code> to see them, <code>om-skills core</code> to print a skill, <code>om-tools2bash</code> to generate direct shell wrappers."],
];

/** Tabbed install box: role=tablist is added by app.js, so no-JS shows every panel. */
function installBox(prefix = "") {
  const tabs = INSTALL.map((m, i) =>
    `<button type="button" class="install-tab" data-tab="${prefix}${m.id}" aria-selected="${i === 0}">${m.label}</button>`).join("");
  const panels = INSTALL.map((m, i) => `<div class="install-panel" data-panel="${prefix}${m.id}"${i === 0 ? "" : " data-inactive"}>
      <span class="install-note">${m.note}</span>
      <pre><code>${m.code.split("\n").map((line) => `<span class="prompt">$</span> ${escapeHtml(line)}`).join("\n")}</code></pre>
      <button type="button" class="copy" data-copy="${escapeHtml(m.code)}">Copy</button>
    </div>`).join("\n    ");
  return `<div class="install" data-tabs>
    <div class="install-tabs">${tabs}</div>
    ${panels}
  </div>`;
}

function terminal() {
  const lines = WALKTHROUGH.map(([cmd, note], i) =>
    `<li style="--i:${i}"><span class="prompt">$</span> <span class="cmd">${escapeHtml(cmd)}</span><span class="note"># ${note}</span></li>`).join("\n      ");
  return `<figure class="terminal reveal" aria-label="Omoya commands, annotated">
    <div class="terminal-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="terminal-title">~/project — om</span></div>
    <ol class="terminal-body">
      ${lines}
      <li class="cursor-line" style="--i:${WALKTHROUGH.length}"><span class="prompt">$</span> <span class="cursor" aria-hidden="true"></span></li>
    </ol>
  </figure>`;
}

export function homePage() {
  return page({
    title: site.title,
    description: site.description,
    path: "/",
    body: `<section class="hero">
  <svg class="hero-logo" viewBox="0 0 512 512" width="96" height="96" aria-hidden="true" focusable="false"><rect width="512" height="512" rx="112"/><circle cx="256" cy="256" r="142"/><path d="M218 207 274 256 218 305 M282 305h38"/></svg>
  <p class="eyebrow">Omoya · transparent Bun agent harness</p>
  <h1>See what your agent <em>sees</em>.</h1>
  <p class="lede">One zero-dependency Bun core for a terminal interface, a scriptable headless loop, and an embeddable library. Filesystem boundaries are enforced by the OS, not by prompt instructions, and every shipped provider normalizes into one event model.</p>
  ${installBox()}
  <p class="hero-links"><a href="./api/">Read the docs →</a><a href="${site.repository}">Source on GitHub →</a><a href="https://www.npmjs.com/package/omoya">npm →</a></p>
</section>
<section class="demo" aria-label="Walkthrough">
  ${terminal()}
</section>
<section aria-labelledby="why-heading" class="band">
  <p class="section-kicker">Why Omoya</p>
  <h2 id="why-heading">The project is the unit of everything.</h2>
  <ol class="why">
${WHY.map(([title, body]) => `    <li class="reveal"><h3>${title}</h3><p>${body}</p></li>`).join("\n")}
  </ol>
</section>
<section aria-labelledby="surfaces-heading" class="band">
  <p class="section-kicker">One core, every surface</p>
  <h2 id="surfaces-heading">Run it where the work is.</h2>
  <div class="surfaces">
${SURFACES.map((s) => `    <article class="surface reveal">
      <div class="surface-text"><p class="surface-kicker">${s.kicker}</p><h3>${s.title}</h3><p>${s.body}</p></div>
      <pre><code>${escapeHtml(s.code)}</code></pre>
    </article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="security-heading" class="band split">
  <div>
    <p class="section-kicker">Security</p>
    <h2 id="security-heading">Side-effects stay in the agent's folder.</h2>
    <p>Each agent has a working folder (defaults to <code>cwd</code>), <strong>making it the agent's root</strong>, enforced in layers rather than by prompt instructions. <code>--safe</code> selects the read-only posture at any time.</p>
  </div>
  <div>
    <ul class="checks">
${SECURITY.map((item) => `      <li class="reveal">${item}</li>`).join("\n")}
    </ul>
    <p class="callout reveal"><strong>Note:</strong> the OS sandbox confines writes, not reads — an agent can always find ways to read external data, even though its tools block its ability to alter that data. See <a href="${site.repository}/blob/main/SECURITY.md">SECURITY.md</a>.</p>
  </div>
</section>
<section aria-labelledby="environment-heading" class="band split">
  <div>
    <p class="section-kicker">Providers</p>
    <h2 id="environment-heading">Auto-detected endpoints.</h2>
    <p>Auto-detection reads the environment and probes local servers — a running Ollama or LM Studio server becomes a ready endpoint with no configuration, re-detected at every startup.</p>
    <p><code>om --login</code> walks through hosted, OAuth, token-based, and local endpoints. A provider is a single protocol module; see the <a href="./api/">API reference</a> to add your own.</p>
  </div>
  <table class="reveal">
    <thead><tr><th>found</th><th>endpoint</th></tr></thead>
    <tbody>
${DETECTED.map(([found, endpoint]) => `      <tr><td>${found}</td><td>${endpoint}</td></tr>`).join("\n")}
    </tbody>
  </table>
</section>
<section aria-labelledby="principles-heading" class="band">
  <p class="section-kicker">Yours to control</p>
  <h2 id="principles-heading">Owned by you, visible to you.</h2>
  <div class="grid principles">
${PRINCIPLES.map(([title, body]) => `    <article class="card reveal"><h3>${title}</h3><p>${body}</p></article>`).join("\n")}
  </div>
</section>
<section aria-labelledby="start-heading" class="band cta">
  <h2 id="start-heading">Start in one minute.</h2>
  <p>Every shipped command — <code>omoya</code> and its short form <code>om</code>, <code>om-agent</code>, <code>om-io</code>, <code>om-tool</code>, <code>om-skills</code>, <code>om-jobs</code>, <code>om-tools2bash</code> — has built-in <code>--help</code>. The full API is in the <a href="./api/">generated reference</a>.</p>
  ${installBox("cta-")}
</section>`,
  });
}
