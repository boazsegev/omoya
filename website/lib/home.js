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

const BUN_LINK = '<a href="https://bun.sh/" target="_blank" rel="noopener noreferrer">Bun (opens in new tab)</a>';
const SEARXNG_LINK = '<a href="https://docs.searxng.org/" target="_blank" rel="noopener noreferrer">SearXNG (opens in new tab)</a>';

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
  ["om --safe", "read-only tools only"],
  ['echo "Summarize this project" | om-agent', "JSONL events on stdout"],
  ["om --serve --port 9900", "the same agent, in your browser"],
];

const WHY = [
  ["See everything", "Read and edit the exact context the model receives. Watch every tool call and see a diff of every edit."],
  ["Writes stay in the agent's folder", "The OS sandbox enforces this, not a prompt. Without a sandbox, only read-only tools run."],
  ["Each project keeps its own memory", "Skills, prompts, settings, and jobs live in <code>ai-</code> files inside the project folder. This limits context leaks between projects."],
  ["Good work habits come built in", "The <code>core</code> skill teaches agents to keep memory files and task lists, and to delegate well."],
  ["No setup for what you already have", `Omoya finds local Ollama and LM Studio servers, ${SEARXNG_LINK}, and common API keys on its own.`],
  ["Switch models freely", "All providers speak one event model. You can switch providers and models mid-session, and nothing else changes."],
];

const SURFACES = [
  {
    kicker: "Terminal",
    title: "An interface that hides nothing",
    body: "<code>om</code> streams answers and thinking as they arrive. It shows every tool call, and you can inspect or fix any part of the conversation. <kbd>Ctrl-O</kbd> shows the full text of any message or tool call. <kbd>Ctrl-C</kbd> stops a response and keeps what arrived so far. <code>/context-edit</code>, <code>/context-rollback</code>, and <code>/context-system</code> fix, rewind, or extend what the model sees.",
    code: "om --resume latest   # pick up where you left off\nom --help            # every key and command",
  },
  {
    kicker: "Browser",
    title: "Your terminal agent, in the browser",
    body: "The browser app runs the same agent engine as the terminal. You get all of the terminal's features in a web interface. Closing a tab doesn't stop the agent's work, and one server can host several projects.</p><p><strong>Safe by default.</strong> The server listens only on loopback, so nothing outside your machine can reach it. Omoya blocks DNS-rebinding attacks, so websites in your browser can't control it either.</p><p><strong>LAN access is opt-in.</strong> <code>--host 0.0.0.0</code> lets other devices on your network use the app. Rebinding protection stays on, so this is just as safe on trusted networks. Never use it on public Wi-Fi. With <code>omd</code>, you can restart the app from the browser when you want a fresh start.",
    code: "om --serve --port 9900\nomd --port 9900      # keep the app and jobs running",
  },
  {
    kicker: "Scripts",
    title: "Drive it from a script",
    body: "<code>om-agent</code> runs the full agent loop without the terminal interface. It reads a conversation on stdin and writes JSONL events to stdout. <code>om-io</code> sends exactly one request to the model and runs no tools. Each kind of failure has its own exit code.",
    code: 'echo "Summarize this project" \\\n  | om-agent --model ollama/gpt-oss:20b\n\necho "Hello" \\\n  | om-io --model anthropic/claude-sonnet-5',
  },
  {
    kicker: "Library",
    title: "Inside your program",
    body: "<code>omoya/agent</code> is the headless core. Import <code>omoya/app</code> to add the terminal, browser, and Markdown layers. Semantic versioning covers the library, not the App and GTUI APIs.",
    code: 'import Agent from "omoya/agent";\n\nconst env = await Agent.Env.open(process.cwd());\nconst agent = await Agent.create({\n  env, model: "ollama/gpt-oss:20b", can: { write: false },\n});',
  },
  {
    kicker: "Sessions & jobs",
    title: "Sessions and jobs",
    body: "Omoya saves sessions as JSONL files. You can resume, rename, edit, roll back, fork, or delete them. <code>om-jobs</code> runs scheduled agent tasks, each a plain Markdown file in <code>ai-jobs/tasks/</code>. Run it from cron, or let <code>omd</code> run it about every five minutes.",
    code: "om-jobs init     # create ai-jobs/ (idempotent)\nom-jobs run      # one best-effort scan, executes due tasks",
  },
];

const SECURITY = [
  "Each agent can only write inside its working folder.",
  "The OS sandbox (macOS Seatbelt, Linux Bubblewrap) enforces this. Without a sandbox, <strong>only read-only tools run</strong>.",
  "Child agents get the same folder or a smaller one.",
  "Programs the agent starts don't inherit variables with names like <code>KEY</code>, <code>TOKEN</code>, or <code>SECRET</code>.",
  "Session logs live in your user settings folder, outside the project, by default.",
];

const DETECTED = [
  ["<code>OPENAI_API_KEY</code>", "<code>openai</code>"],
  ["<code>ANTHROPIC_API_KEY</code>", "<code>anthropic</code>"],
  ["<code>MOONSHOT_API_KEY</code>", "<code>moonshot</code> (Kimi Platform)"],
  ["<code>KIMI_API_KEY</code>", "<code>kimi</code> (Kimi Platform)"],
  ["Ollama running on <code>localhost:11434</code>", "<code>ollama</code>"],
  ["LM Studio running on <code>localhost:1234</code>", "<code>lm-studio</code>"],
  ["<code>XAI_API_KEY</code>", "<code>xai</code>"],
  ["<code>AZURE_OPENAI_API_KEY</code> + <code>AZURE_OPENAI_BASE_URL</code>", "<code>azure-openai</code>"],
  ["<code>GEMINI_API_KEY</code> or <code>GOOGLE_API_KEY</code>", "<code>gemini</code>"],
];

const PRINCIPLES = [
  ["The system message is yours", "Each new session builds its instructions from three <code>AGENTS.md</code> files: Omoya's own, your user folder's, and the project's. Nothing hidden sits between your instructions and the model."],
  ["The project is the unit of memory", "What an agent learns stays in its project folder, in files such as <code>ai-settings.json</code>, <code>ai-skills/</code>, and <code>AGENTS.md</code>. Other projects can't see them. To share something everywhere, put it in your user settings folder."],
  ["Web search without an account", `Omoya tries the provider's own web tools, then an MCP server, then its built-in search. Built-in search uses ${SEARXNG_LINK} if you have it, then DuckDuckGo and Mojeek. Set <code>BRAVE_API_KEY</code> to add Brave.`],
  ["Direct tool access", "Run any tool straight from your shell. <code>om-tool --list</code> lists them, <code>om-skills core</code> prints a skill, and <code>om-tools2bash</code> writes shell wrappers."],
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
  <p class="lede">Omoya runs an AI agent in your terminal, your browser, a script, or your own program. All four share one small ${BUN_LINK} core with no dependencies. You can read and edit everything the model sees. The operating system keeps the agent's writes inside its folder.</p>
  ${installBox()}
  <p class="hero-links"><a href="./api/">Read the docs →</a><a href="${site.repository}">Source on GitHub →</a><a href="https://www.npmjs.com/package/omoya">npm →</a></p>
</section>
<section class="demo" aria-label="Walkthrough">
  ${terminal()}
</section>
<section aria-labelledby="why-heading" class="band">
  <p class="section-kicker">Why Omoya</p>
  <h2 id="why-heading">See what the model sees, and decide what it can change.</h2>
  <ol class="why">
${WHY.map(([title, body]) => `    <li class="reveal"><h3>${title}</h3><p>${body}</p></li>`).join("\n")}
  </ol>
</section>
<section aria-labelledby="surfaces-heading" class="band">
  <p class="section-kicker">One core, four ways to run it</p>
  <h2 id="surfaces-heading">Terminal, browser, script, or your own program.</h2>
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
    <h2 id="security-heading">Writes stay in the agent's folder.</h2>
    <p>The operating system enforces this, not a prompt. <code>--safe</code> limits the agent to read-only tools at any time.</p>
  </div>
  <div>
    <ul class="checks">
${SECURITY.map((item) => `      <li class="reveal">${item}</li>`).join("\n")}
    </ul>
    <p class="callout reveal"><strong>Note:</strong> the sandbox limits writes, not reads. An agent can still read data outside its folder, but it can't change it. See <a href="${site.repository}/blob/main/SECURITY.md">SECURITY.md</a>.</p>
  </div>
</section>
<section aria-labelledby="environment-heading" class="band split">
  <div>
    <p class="section-kicker">Providers</p>
    <h2 id="environment-heading">Bring the models you already use.</h2>
    <p>Omoya speaks the OpenAI, Anthropic, Kimi/Moonshot, Ollama, and Gemini APIs. Ready-made endpoints cover services such as Codex, Claude, GitHub Copilot, LM Studio, Azure OpenAI, and xAI.</p>
    <p><code>om --login</code> sets up any endpoint. Omoya also finds the API keys and local servers in this table on its own. Finding models can be slow, so log in with your API keys to cache the model lists.</p>
    <p><strong>Claude OAuth caution:</strong> Anthropic may restrict accounts that use subscription quotas with other harnesses. Use an Anthropic API key or extra credits instead.</p>
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
  <h2 id="start-heading">Get started.</h2>
  <p>Every command has built-in <code>--help</code>. Settings and other details are in the <a href="${site.repository}/blob/main/GUIDE.md">guide</a>. The library API is in the <a href="./api/">generated reference</a>.</p>
  ${installBox("cta-")}
</section>`,
  });
}
