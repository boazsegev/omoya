/**
 * lib/tui-app/menu-actions.js — a selected menu item's `value` into
 * one of: drill into a sub-menu (menu-data.js builders — every value
 * already carries whatever data its sub-menu needs, e.g. `value.sessions`),
 * insert text into the draft box, run an existing (already-tested)
 * slash command through lib/tui-app/commands.js, or close. Parity with
 * lib/tui-helpers/repl-overlays.js's applyMenuEffect, without automatic OAuth
 * (the login sub-menu still opens; a preset's browser sign-in isn't
 * run yet — see menu-data.js's buildLoginItems).
 */

import { buildHelpItems, buildLoginItems, buildLogoutItems, buildProviderItems, buildPromptItems, buildResumeItems, buildToolsItems, buildThemeItems, buildSpawnPermissionItems, buildSessionAddItems, buildSessionAddModelItems, buildSessionCloseItems, buildSessionMenuItems, buildSessionNewItems } from "./contracts.js";

/**
 * @param {object} value - the selected item's value (menu-data.js shape)
 * @param {object} env - Env, needed only for the login sub-menu's presets
 * @returns {{kind: "pop"}|{kind: "push", title: string, items: Array}|
 *   {kind: "insert", text: string}|{kind: "command", lines: string[]}|
 *   {kind: "close"}|{kind: "unsupported"}}
 */
export function resolveMenuAction(value, env) {
  switch (value.type) {
    case "back": return { kind: "pop" };
    case "agent.switch": return { kind: "switch-agent", agent: value.agent };
    case "help": return { kind: "push", title: "Help", items: buildHelpItems() };
    case "sessions": return { kind: "push", title: "Resume", items: buildResumeItems({ sessions: value.sessions }) };
    case "prompts": return { kind: "push", title: "Prompts", items: buildPromptItems({ prompts: value.prompts }) };
    case "tools": return { kind: "push", title: "Tools", items: buildToolsItems({ tools: value.tools }) };
    case "logout-menu": return { kind: "push", title: "Logout", items: buildLogoutItems({ endpoints: value.endpoints }) };
    case "session-menu": return { kind: "push", title: "Sessions", items: buildSessionMenuItems(value) };
    case "session-add-menu": return { kind: "push", title: "Sessions / Add", items: buildSessionAddItems(value) };
    case "session-add-provider": return { kind: "push", title: `Sessions / Add / ${value.endpoint}`, items: buildSessionAddModelItems({ endpoint: value.endpoint, models: value.models }) };
    case "session-add": return { kind: "add-agent", endpoint: value.endpoint, model: value.model };
    case "session-new-menu": return { kind: "push", title: "Sessions / New", items: buildSessionNewItems(value) };
    case "session-close-menu": return { kind: "push", title: "Sessions / Close", items: buildSessionCloseItems(value) };
    case "agent.close": return { kind: "close-agent", agent: value.agent };
    case "provider": return { kind: "push", title: value.value, items: buildProviderItems({ value: value.value, models: value.models }) };
    case "login": return { kind: "push", title: "Login", items: buildLoginItems({ presets: env?.knownEndpoints?.() ?? [] }) };
    case "oauth-login": return { kind: "command", lines: ["/endpoint-login"] };
    case "insert": return { kind: "insert", text: value.text };
    case "model": return { kind: "command", lines: [`/endpoint-model ${value.value}`] };
    case "logout": return { kind: "command", lines: [`/endpoint-logout ${value.endpoint}`] };
    case "new-session": return { kind: "command", lines: value.safe ? ["/session-new", "/agent-safe on"] : ["/session-new"] };
    case "anon-session": return { kind: "command", lines: value.safe ? ["/session-new false", "/agent-safe on"] : ["/session-new false"] };
    case "thinking": return { kind: "command", lines: [`/agent-thinking ${value.value}`] };
    case "themes": return { kind: "push", title: "Themes", items: buildThemeItems(value) };
    case "theme.set": return { kind: "theme", value: value.value };
    case "safe": return { kind: "command", lines: [`/agent-safe ${value.value}`] };
    case "session-save": return { kind: "command", lines: [`/agent-session-save ${value.value}`] };
    case "spawn-permission-menu": return { kind: "push", title: "Allow to Delegate", items: buildSpawnPermissionItems(value) };
    case "spawn-permission": return { kind: "spawn-permission", value: value.value };
    case "resume": return { kind: "command", lines: [`/session-resume ${value.value}`] };
    case "none": return { kind: "close" };
    default: return { kind: "unsupported" };
  }
}
