/**
 * lib/agent/tool-timeout-settings.js — Agent's tool-timeout constants
 * (private): the defaults behind settings.tools.timeout/timeoutLimit
 * (resolved per Agent in lib/agent/policy.js) and the onTimeout grace.
 *
 * The Agent owns enforcement. Tools may DECLARE `timeout`, but the
 * Agent extracts it before invocation; tools never race a second timer
 * against the harness. A tool's optional Agent-facing `onTimeout`
 * callback gets one bounded cleanup/final-response grace period.
 */

import { DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT } from "../tool-runtime.js";
export { DEFAULT_TOOL_TIMEOUT, DEFAULT_TOOL_TIMEOUT_LIMIT };
/** Maximum Agent-facing onTimeout cleanup/final-response grace. */
export const TOOL_ON_TIMEOUT_LIMIT = 60_000;
