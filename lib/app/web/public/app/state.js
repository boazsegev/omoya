/** Browser-local mutable client state and persistent preferences, shared by concern modules. */
/**
 * Read a localStorage preference.
 * @param {string} key
 * @param {*} fallback - returned when the key is unset or storage is unavailable (private mode).
 * @returns {*} the stored string or `fallback`.
 */
function readPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
/**
 * Persist a localStorage preference.
 * @param {string} key
 * @param {string} value
 * @returns {void}
 * Errors: silently ignored when storage is unavailable (private mode).
 */
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

// Read once at startup, before panels build their shortcut catalog.
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);

export const state = {
  connection: "closed",
  throttledUntil: null,
  throttleClock: null,
  agent: null,
  sessions: { agents: [], recent: [] },
  projects: [],
  // "all": the root URL lists every project's agents; "project": one project's URL.
  scope: "project",
  group: null, // the viewed group (scope "group")
  canManageProjects: false,
  settings: { safe: false, thinking: "default", sessionSave: undefined, spawnPermission: null, delegationLocked: false, endpoint: null, model: null, models: [] },
  prefs: { autocomplete: true, collapse: { thinking: true, tools: true }, previewRows: { default: { system: 8, thinking: 8, tool: 7 } }, theme: "system", thinkingLevels: ["default", "none", "low", "medium", "high", "xhigh", "max"], themes: [], activeTheme: null, themeModes: {} },
  catalog: { commands: [], hints: {}, prompts: [], tools: [], toolSchemas: [] },
  endpoints: { endpoints: [], presets: [], removable: [], providers: [], policies: [] },
  usage: { input: 0, output: 0, used: 0, available: 0, plan: null },
  oauthState: { active: false, url: null, lines: [], done: false, error: false },
  contextBlocks: [],
  contextTools: null,
  contextView: null,
  sidebarOpen: readPref("omoya.web.sidebar", matchMedia("(min-width: 64rem)").matches ? "open" : "closed") === "open",
  queuedMessages: [],
  uploadKey: null,
  draftAttachments: [],
  composerByAgent: new Map(),
  blocks: [],
  current: null,
  openQuestion: null,
  sessionFilter: "",
  sessionCollapsed: new Set(), // project paths whose saved-session section is collapsed
  nodes: [],
  rowBlocks: new WeakMap(),
  dirty: new Set(),
  fullRender: true,
  resetTranscript: false,
  stickBottom: false,
  frame: 0,
  frameTimer: 0,
  acItems: [],
  acIndex: -1,
  acArg: false,
  loginSelection: null,
};
export { readPref, writePref };
