/**
 * public/text-safe.js — the SPA's import of the Markdown module's display
 * sanitizer (lib/markdown/text-safe.js), re-exported so the web app shares
 * ONE implementation with the TUI. Served at /text-safe.js; the real path
 * resolves on disk through this shim.
 */
export { sanitizeText, BashSanitizer } from "../../markdown/text-safe.js";
