import { toolDisplay } from "../../format.js";
import { sanitizeText } from "../../text-safe.js";

/** Normalize a wire display into safe Markdown source strings, including scalar diffs. */
export function displaySource(display) {
  return toolDisplay(display).map((text) => sanitizeText(text, { markdown: true }));
}
