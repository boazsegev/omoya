/** Browser-safe synchronous Markdown scanning primitives for presentation targets.
 * Import this public entry instead of the Markdown area's private parsers.
 */
export { findInlineMath, mathBlockAt } from "./math.js";
export { findCodeSpan } from "./inline.js";
