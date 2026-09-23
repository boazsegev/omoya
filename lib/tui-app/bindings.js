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

/** Apply settings `tui.keys` replacements by canonical key spelling. */
export function resolveKeymap(settings = {}) {
  const overrides = settings.tui?.keys ?? {};
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) throw new TypeError("tui.keys must be an object");
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

/** Keys that must reach tui-app before the currently focused GTUI control. */
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
