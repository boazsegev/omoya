/** website/site.js — shared site data, loaded from site.json (one source of truth). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL(".", import.meta.url));
export const site = JSON.parse(readFileSync(join(ROOT, "site.json"), "utf8"));
