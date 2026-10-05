/**
 * lib/agent/names.js — reserved Agent names (private to Agent). A name is
 * reserved when it could read as an address or as a privileged identity:
 * - exactly `new` (a new agent, as in `project@new`), a broadcast address
 *   (`all`, `everyone`), a chat role (`assistant`, `human`, `model`, `tool`,
 *   `function`, `ai`), or the product's own name;
 * - containing `user` (the human side of a conversation), `admin`, `group`,
 *   or another authority word (root, sudo, system, developer, owner,
 *   operator, supervisor, moderator, privilege, authority/authorized).
 * Matching ignores case, compatibility forms (NFKC: full-width, ligatures),
 * combining marks, invisible format characters, common Cyrillic/Greek
 * look-alike letters, and — for the contained words — separators, so
 * `ADMIN`, `ａｄｍｉｎ`, `аdmin` (Cyrillic а) and `ad-min` are all reserved.
 */
import { NAMES } from "../namespace.js";

const EXACT = new Set(["new", "all", "everyone", "assistant", "human", "model", "tool", "function", "ai", NAMES.namespace, NAMES.pr]);
const CONTAINED = /user|admin|group|root|sudo|system|developer|owner|operator|supervisor|moderator|privilege|authori/;
// Latin look-alikes from Cyrillic and Greek (lowercase, after NFKC).
const LOOKALIKE = { "а": "a", "в": "b", "е": "e", "ё": "e", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԛ": "q", "ԝ": "w", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x" };

/** The comparison form of a name: NFKC, lowercase, no marks/format characters, look-alikes mapped. */
const fold = (name) => name.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[\p{M}\p{Cf}]/gu, "").replace(/./gu, (ch) => LOOKALIKE[ch] ?? ch);

/** @returns {boolean} whether `name` is reserved. @param {string} name */
export function nameReserved(name) {
  const folded = fold(name);
  return EXACT.has(folded.trim()) || CONTAINED.test(folded.replace(/[^\p{L}\p{N}]/gu, ""));
}

/** Short description of the reserved names, for error messages. */
export const RESERVED_NAMES = "new, all, everyone, chat roles, the product name, or a name containing user, admin, group, root, sudo, system, developer, owner, operator, supervisor, moderator, privilege, authority";
