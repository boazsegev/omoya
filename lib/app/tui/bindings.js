/** AI-app shortcut precedence. Generic editing/menu/scroll keys stay in GTUI controls. */
import { GTUI } from "../gtui/gtui.js";

// Plain Alt+Left/Right are reserved for focused-input word navigation.
// Agent pagination deliberately requires BOTH Alt and Ctrl. Up is a
// distinct, direct-child-to-parent navigation gesture.
const PEER_PREVIOUS = ["alt+ctrl+left"];
const PEER_NEXT = ["alt+ctrl+right"];
const PARENT_AGENT = "alt+ctrl+up";
const GLOBAL = ["ctrl+x", "ctrl+p", "ctrl+m", "ctrl+o", "alt+shift+f", ...PEER_PREVIOUS, ...PEER_NEXT, PARENT_AGENT];
const INPUT_RESERVED = new Set(["alt+left", "alt+right"]);

/**
 * Resolve shortcut overrides from `settings.tui.keys`, falling back to the
 * built-in peer-navigation, sessions-menu, and fork shortcuts. Alt+Left and
 * Alt+Right are reserved for focused-input word navigation and cannot be
 * assigned through these overrides.
 *
 * @param {object} [settings={}] Application settings; non-nullish `tui.keys`
 *   must be a non-array object. Supported keys are `previousSession`,
 *   `nextSession`, `sessionsMenu`, and `fork`.
 * @returns {{previousSession: *, nextSession: *, sessionsMenu: *, fork: *}}
 *   A frozen keymap object. The configured key values are preserved except
 *   reserved input-navigation keys fall back to their built-in values.
 * @throws {TypeError} If `settings` is nullish or non-nullish
 *   `settings.tui.keys` is a non-object or array.
 * Does not mutate `settings`.
 */
export function resolveKeymap(settings = {}) {
  const overrides = settings.tui?.keys ?? {};
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) throw new TypeError("tui.keys must be an object");
  /**
   * Reject a key override that collides with focused-input word navigation.
   *
   * @param {*} value Configured key or key collection; nullish values use the fallback.
   * @param {*} fallback Default key value when the override is absent or reserved.
   * @returns {*} The override, or the fallback if absent or reserved.
   * Does not mutate either argument.
   */
  const safe = (value, fallback) => {
    const keys = [].concat(value ?? fallback);
    return keys.some((key) => INPUT_RESERVED.has(key)) ? fallback : value ?? fallback;
  };
  return Object.freeze({ previousSession: safe(overrides.previousSession, PEER_PREVIOUS), nextSession: safe(overrides.nextSession, PEER_NEXT),
    sessionsMenu: safe(overrides.sessionsMenu, []), fork: safe(overrides.fork, "alt+shift+f") });
}
const COMPLETION = ["tab", "shift+tab", "down", "up", "enter", "escape"];
const VIEWER = ["left", "right", "alt+left", "alt+right", "f", "c", "escape", "ctrl+c"];
const QUESTION = ["tab", "alt+ctrl+left", "alt+ctrl+right", "escape", "ctrl+c"];

const Main = GTUI.keybindings.create("Main", GLOBAL);
const Menu = GTUI.keybindings.create("Menu", GLOBAL);
const Viewer = GTUI.keybindings.create("Viewer", [...GLOBAL, ...VIEWER]);
const Completion = GTUI.keybindings.create("Completion", [...GLOBAL, ...COMPLETION]);
const ViewerCompletion = GTUI.keybindings.create("ViewerCompletion", [...GLOBAL, ...COMPLETION, ...VIEWER]);
const Question = GTUI.keybindings.create("Question", QUESTION);

/**
 * Select keys that must reach tui-app before the focused GTUI control, based
 * on the active question, completions, viewer, or menu. Additional bindings
 * are appended to a newly composed array when `extra` is non-empty.
 *
 * @param {object} model Current application model, including optional
 *   `question`, `input.completions`, and `overlay.type` state.
 * @param {string[]} [extra=[]] Additional key names to append. When non-empty,
 *   the returned array is composed from the applicable bindings and these keys.
 * @returns {string[]} The applicable keybindings; without extra keys this may
 *   be a shared, pre-created binding array.
 * @throws {TypeError} If `model` is nullish, an existing `model.input`
 *   lacks a usable `completions.length`, `extra` is nullish, or non-empty
 *   `extra` is not iterable.
 * Does not mutate the model or `extra`.
 */
export function appBindings(model, extra = []) {
  if (extra.length > 0) {
    const completion = (model.input?.completions.length ?? 0) > 0;
    const viewer = model.overlay?.type === "viewer";
    const base = model.question ? QUESTION
      : completion ? [...GLOBAL, ...COMPLETION, ...(viewer ? VIEWER : [])]
      : viewer ? [...GLOBAL, ...VIEWER] : GLOBAL;
    return [...base, ...extra];
  }
  if (model.question || model.overlay?.type === "viewer-filter") return Question;
  const completion = (model.input?.completions.length ?? 0) > 0;
  const viewer = model.overlay?.type === "viewer";
  if (completion) return viewer ? ViewerCompletion : Completion;
  if (viewer) return Viewer;
  return model.overlay?.type === "menu" ? Menu : Main;
}

export const bindingInternals = Object.freeze({ Main, Menu, Viewer, Completion, ViewerCompletion, Question });
