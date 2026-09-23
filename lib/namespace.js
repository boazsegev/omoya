/** The single product namespace switch. Internal const — the public
 * namespace variations live on NAMES, derived from it in one place. */
const NAMESPACE = "Omoya";
const PREFIX = "om";

const _ns = NAMESPACE.toLowerCase();
const _NS = NAMESPACE.toUpperCase();
const _pr = PREFIX.toLowerCase();
const _PR = PREFIX.toUpperCase();

/** Namespace-derived runtime names. `Namespace` is the canonical product
 * name; the public library façades retain their own names (see lib/index.js).
 * The UPPER/lower variations supply prefixes for environment variables and
 * namespace-specific runtime paths. */
export const NAMES = Object.freeze({
  Namespace: NAMESPACE,
  NAMESPACE: _NS,
  namespace: _ns,
  Pr: PREFIX,
  pr: _pr,
  PR: _PR,
  settingsEnv: `${_NS}_SETTINGS_DIR`,
  skillsEnv: `${_NS}_SKILLS_DIR`,
  promptsEnv: `${_NS}_PROMPTS_DIR`,
  systemEnv: `${_NS}_SYSTEM`,
  osSandboxEnv: `${_NS}_OS_SANDBOX`,
  toolWorkerEnv: `${_NS}_TOOL_WORKER`,
  testScriptEnv: `${_NS}_TEST_SCRIPT`,
  settingsHome: `.${_ns}-settings`,
  projectSettings: `ai-settings.json`,
  projectAuthPrefix: `ai-auth-`,
  projectSkillsDir: `ai-skills`,
  projectPromptsDir: `ai-prompts`,
  sessionsDir: `sessions`,
  tempDir: `ai-tmp`,
  agentName: `${_ns}-agent`,
  /** The CLI wrapper prefix — the base of every bin/<prefix>-* wrapper
   * and, unprefixed, the app's own command (bin/<prefix> -> scripts/app;
   * the headless agent CLI is bin/<prefix>-agent). */
  cliPrefix: _pr,
  realAgentSymbol: `${_ns}.realAgent`,
});
