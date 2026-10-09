/**
 * lib/app/cli.js — CLI-owned process-facing command helpers.
 *
 * Exposes process-facing command helpers used by executables.
 */

import { parseFlags } from "./cli/flags.js";
import { EXIT, exitCodeFor, close } from "./cli/exit.js";
import { readStdin, readContextFromStdin } from "./cli/stdin.js";
import { selectEndpointModel } from "./cli/select.js";
import { armCancelSignals } from "./cli/signals.js";
import { finishSignalsArm } from "./cli/finish-signals.js";
import { runLoginWizard } from "./cli/login.js";
import { runMcpLogin } from "./cli/mcp-login.js";
import { writeSettingsTemplate } from "./cli/init.js";
import { adoptResumeOrigin } from "./cli/resume.js";
import { usageSummary } from "./cli/usage.js";

export { parseFlags } from "./cli/flags.js";
export { EXIT, exitCodeFor, close } from "./cli/exit.js";
export { readStdin, readContextFromStdin } from "./cli/stdin.js";
export { selectEndpointModel } from "./cli/select.js";
export { armCancelSignals } from "./cli/signals.js";
export { finishSignalsArm } from "./cli/finish-signals.js";
export { runLoginWizard } from "./cli/login.js";
export { runMcpLogin } from "./cli/mcp-login.js";
export { writeSettingsTemplate } from "./cli/init.js";
export { adoptResumeOrigin } from "./cli/resume.js";
export { usageSummary } from "./cli/usage.js";

/** Static namespace exposing every named CLI operation. */
export class CLI {}
Object.assign(CLI, {
  parseFlags, EXIT, exitCodeFor, close, readStdin, readContextFromStdin,
  selectEndpointModel, armCancelSignals, finishSignalsArm,
  runLoginWizard, runMcpLogin, writeSettingsTemplate,
  adoptResumeOrigin, usageSummary,
});
export default CLI;
