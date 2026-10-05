/**
 * lib/cli.js — shared process-facing command helpers.
 *
 * Exposes the CLI bindings used by executables and the TUI. `execute` creates
 * and closes its environment; other helpers use the environment supplied by
 * their caller.
 */

import { parseFlags } from "./cli/flags.js";
import { EXIT, exitCodeFor, close } from "./cli/exit.js";
import { readStdin, readContextFromStdin } from "./cli/stdin.js";
import {
  resolveModelCombo, listModelCandidates, listEndpoints, listEndpointModels, listModels, readLastCombo,
} from "./cli/model.js";
import { selectEndpointModel } from "./cli/select.js";
import { endpointPolicies, endpointPolicySet } from "./cli/endpoint-policy.js";
import { armCancelSignals } from "./cli/signals.js";
import { loginEndpoint, logoutEndpoint, runLoginWizard, defaultUrl } from "./cli/login.js";
import { runMcpLogin } from "./cli/mcp-login.js";
import { renderSettingsTemplate, writeSettingsTemplate } from "./cli/init.js";
import { resolveToolArgs, resolveCliToolArgs, unwrapToolResult, formatToolResult } from "./cli/tool-run.js";
import { runOAuthFlow, completeOAuthPaste, refreshOAuthTokens, tokensToAuth, parseAuthorizationInput, oauthPasteOnly } from "./cli/oauth.js";
import { adoptResumeOrigin } from "./cli/resume.js";
import Context from "./context.js";
import Env from "./env.js";
const { usageSummary } = Context;

export { parseFlags } from "./cli/flags.js";
export { EXIT, exitCodeFor, close } from "./cli/exit.js";
export { readStdin, readContextFromStdin } from "./cli/stdin.js";
export { resolveModelCombo, listModelCandidates, listEndpoints, listEndpointModels, listModels, readLastCombo } from "./cli/model.js";
export { selectEndpointModel } from "./cli/select.js";
export { endpointPolicies, endpointPolicySet } from "./cli/endpoint-policy.js";
export { armCancelSignals } from "./cli/signals.js";
export { loginEndpoint, logoutEndpoint, runLoginWizard, defaultUrl } from "./cli/login.js";
export { runMcpLogin } from "./cli/mcp-login.js";
export { renderSettingsTemplate, writeSettingsTemplate } from "./cli/init.js";
export { resolveToolArgs, resolveCliToolArgs, unwrapToolResult, formatToolResult } from "./cli/tool-run.js";
export { runOAuthFlow, completeOAuthPaste, refreshOAuthTokens, tokensToAuth, parseAuthorizationInput, oauthPasteOnly } from "./cli/oauth.js";
export { adoptResumeOrigin } from "./cli/resume.js";
export { usageSummary } from "./context.js";

/** Execute one normalized administrative command.
 * Argument parsing and flag names remain the executable's concern. This
 * function creates an environment and closes it in a `finally` block, even if
 * command handling fails.
 * @param {{type: "login"|"mcpLogin"|"logout"|"initialize"|"listModels", endpoint?: string, force?: boolean}} command Required command object; `type` selects the operation. `endpoint` is used by `logout` and defaults to `undefined` when omitted. `force` is used by `initialize` and defaults to `false`.
 * @returns {Promise<
 *   {type: "login", name: string, endpoint: object, auth?: object, scope: string, verified?: *} |
 *   {type: "mcpLogin", name: string} |
 *   {type: "logout", name: string, dynamic: boolean} |
 *   {type: "initialize", file: string} |
 *   {type: "listModels", endpoints: Array<{name: string, models: string[]}>}
 * >} A promise for the result corresponding to `command.type`.
 * @throws {Error} If `command.type` is unknown. Errors from environment creation, the selected operation, or environment cleanup may also propagate.
 */
export async function execute(command) {
  const env = await Env.create();
  try {
    if (command.type === "login") return { type: "login", ...(await runLoginWizard(env)) };
    if (command.type === "mcpLogin") return { type: "mcpLogin", ...(await runMcpLogin(env, command.endpoint)) };
    if (command.type === "logout") return { type: "logout", ...logoutEndpoint(env, command.endpoint) };
    if (command.type === "initialize") return { type: "initialize", file: writeSettingsTemplate(env, { force: command.force === true }) };
    if (command.type === "listModels") return { type: "listModels", endpoints: await listModels(env) };
    throw new Error(`unknown CLI command: ${command.type}`);
  } finally {
    close({ env });
  }
}

/** Static namespace exposing every named CLI helper and `execute`. */
export class CLI {}
Object.assign(CLI, {
  parseFlags, EXIT, exitCodeFor, close, readStdin, readContextFromStdin,
  resolveModelCombo, listModelCandidates, listEndpoints, listEndpointModels, listModels, readLastCombo,
  selectEndpointModel, endpointPolicies, endpointPolicySet, armCancelSignals,
  loginEndpoint, logoutEndpoint, runLoginWizard, runMcpLogin, defaultUrl,
  renderSettingsTemplate, writeSettingsTemplate,
  resolveToolArgs, resolveCliToolArgs, unwrapToolResult, formatToolResult,
  runOAuthFlow, completeOAuthPaste, refreshOAuthTokens, tokensToAuth, parseAuthorizationInput, oauthPasteOnly,
  adoptResumeOrigin, usageSummary, execute,
});
export default CLI;
