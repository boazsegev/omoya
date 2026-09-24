/**
 * GTUI public façade for synchronous terminal applications.
 *
 * GTUI owns view geometry, rendering, terminal controls, selection, editing,
 * and key decoding. Applications own semantic policy and conversation state;
 * TUI turn lifecycle remains in lib/tui-app/. Hosts provide terminal I/O and
 * receive rendered scenes and effects. Interactive input, including key events,
 * is applied immediately; background frames are not used to delay input. GTUI
 * is not a web-app abstraction.
 */

import { createControls } from "./controls.js";
import { layoutView } from "./layout.js";
import { createTheme } from "./theme.js";
import { createTerminalHost } from "./terminal-host.js";
import { canonicalKey, compileBindings, createKeybindings, decodeKey, matchesBinding } from "./keymap.js";
import { graphemeWidth, graphemes } from "./width.js";

const freeze = (value) => Object.freeze(value);
const node = (type) => (props = {}, children = []) => freeze({
  type,
  ...props,
  children: freeze(Array.isArray(children) ? [...children] : [children]),
});
const makeEvent = (type, payload = {}) => freeze({ type, ...payload });
const isPromiseLike = (value) => value !== null && typeof value === "object" && typeof value.then === "function";
// Window lifecycle is a host-only protocol. Menu actions may legitimately
// use the ordinary words "back" and "close"; they are app messages, never
// instructions to tear down the terminal.
const isHostQuit = (message) => message?.type === "host.quit";
// Terminal interaction is sequential state, not a background stream: a
// control opened by one key must be mounted before the next key from the
// same input chunk is decoded. Provider/task messages coalesce to one
// cancellable event-loop frame, leaving input I/O a chance to run.
const INTERACTIVE_MESSAGES = new Set([
  "key", "paste", "pointer", "resize", "focus", "selection.copy",
  "input.change", "input.submit", "menu.change", "menu.select", "menu.cancel", "action.select", "link.open", "selection.change", "selection.preview",
]);

/** Immutable constructors for renderable view nodes. */
export const view = freeze({
  /** Create immutable text content. */
  text: (props = {}, content = "") => freeze({ type: "text", ...props, content }),
  /** Create an immutable table with frozen rows and cells. */
  table: (props = {}, rows = []) => freeze({ type: "table", ...props, rows: freeze([...rows].map((row) => freeze({ ...row, cells: freeze((row.cells ?? []).map((cell) => freeze([...cell]))) }))) }),
  /** Create an immutable horizontal container. */
  row: node("row"),
  /** Create an immutable vertical container. */
  column: node("column"),
  /** Create an immutable grid container. */
  grid: node("grid"),
  /** Create an immutable bordered panel. */
  panel: node("panel"),
  /** Create an immutable feed control. */
  feed: (props = {}) => freeze({ type: "feed", ...props }),
  /** Create an immutable scroll container. */
  scroll: node("scroll"),
  /** Create an immutable overlay container. */
  overlay: node("overlay"),
  /** Create an immutable text input control. */
  input: (props = {}) => freeze({ type: "input", ...props }),
  /** Create an immutable menu control. */
  menu: (props = {}) => freeze({ type: "menu", ...props }),
});

/** Immutable constructors for host, task, timer, theme, and lifecycle effects. */
export const effect = freeze({
  /** Run an abortable asynchronous task. */
  task: (key, run) => freeze({ type: "task", key, run }),
  /** Cancel the task for a key. */
  cancel: (key) => freeze({ type: "cancel", key }),
  /** Deliver a message after a delay. */
  after: (ms, message) => freeze({ type: "after", ms, message }),
  /** Copy text through the host. */
  copy: (text, id) => freeze({ type: "copy", text, ...(id === undefined ? {} : { id }) }),
  /** Ask the host to open a URL. */
  open: (url) => freeze({ type: "open", url }),
  /** Ask the host to show a notification. */
  notify: (text) => freeze({ type: "notify", text }),
  /** Replace theme tokens. */
  theme: (tokens) => freeze({ type: "theme", tokens }),
  /** Request a render without changing the model. */
  refresh: () => freeze({ type: "refresh" }),
  /** End the application with a status code. */
  quit: (code = 0) => freeze({ type: "quit", code }),
});

/** Immutable constructors for messages delivered to an application update function. */
export const event = freeze({
  /** Create a key event. */
  key: (payload) => makeEvent("key", payload),
  /** Create a paste event. */
  paste: (payload) => makeEvent("paste", payload),
  /** Create a pointer event. */
  pointer: (payload) => makeEvent("pointer", payload),
  /** Create a resize event. */
  resize: (payload) => makeEvent("resize", payload),
  /** Create a focus event. */
  focus: (payload) => makeEvent("focus", payload),
  /** Create an input-change event. */
  inputChange: (payload) => makeEvent("input.change", payload),
  /** Create an input-submit event. */
  inputSubmit: (payload) => makeEvent("input.submit", payload),
  /** Create a menu-selection event. */
  menuSelect: (payload) => makeEvent("menu.select", payload),
  /** Create a menu-cancel event. */
  menuCancel: (payload = {}) => makeEvent("menu.cancel", payload),
  /** Create a selection-copy event. */
  selectionCopy: (payload) => makeEvent("selection.copy", payload),
  /** Create a link-open event. */
  linkOpen: (payload) => makeEvent("link.open", payload),
  /** Create a completed-task event. */
  taskDone: (payload) => makeEvent("task.done", payload),
  /** Create a failed-task event. */
  taskFailed: (payload) => makeEvent("task.failed", payload),
  /** Create a completed-copy event. */
  copyDone: (payload) => makeEvent("copy.done", payload),
});

/**
 * Create an in-memory host for application tests.
 * It records rendered semantics and effects; it never emits terminal bytes.
 * @param {{width?: number, height?: number, scrollBar?: object}} [options]
 * @returns {object} host implementing the GTUI host protocol
 */
export function memory({ width = 80, height = 24, scrollBar } = {}) {
  const state = { width, height, view: null, scene: null, effects: [], listener: null, binding: null, restoreCount: 0, controls: null, theme: null };
  state.controls = createControls((message) => state.listener?.(message), { scrollBar });
  return freeze({
    /** Send a host input message to the mounted application. */
    send(message) {
      if (state.binding?.(message) || !state.controls.handle(message)) state.listener?.(message);
    },
    /** Finish pending host output; memory hosts have nothing to flush. */
    flush() {},
    /** Return the current rendered scene in semantic, testable form. */
    snapshot() {
      const snapshot = state.scene?.snapshot ?? { lines: [], roles: [], links: [], sources: [], focus: null, caret: null };
      return { ...snapshot, width: state.width, height: state.height };
    },
    /** Recorded effects, copied so callers cannot mutate host state. */
    get effects() { return [...state.effects]; },
    /** Number of completed host restoration cycles. */
    get restoreCount() { return state.restoreCount; },
    /** Start the runtime-to-host message protocol. */
    _start(listener, binding) { state.listener = listener; state.binding = binding; },
    /** Render a view through the in-memory layout engine. */
    _render(next) {
      state.view = next;
      state.scene = layoutView(next, { width: state.width, height: state.height, controls: state.controls, theme: state.theme });
    },
    /** Install the resolved theme for subsequent layouts. */
    _setTheme(theme) { state.theme = theme; },
    /** Record an effect and acknowledge copy effects asynchronously. */
    _effect(value, send) {
      state.effects.push(value);
      if (value.type === "copy") queueMicrotask(() => send?.(event.copyDone({ id: value.id, ok: true })));
    },
    /** Clear runtime callbacks and record host restoration. */
    _restore() {
      state.listener = null;
      state.binding = null;
      state.restoreCount++;
    },
  });
}

/**
 * Construct a terminal host that owns input decoding and terminal rendering.
 * @param {object} [options] terminal streams, mode, dimensions, and policies
 * @returns {object} opaque GTUI host
 */
export function terminal(options = {}) {
  if (options.host) return options.host;
  return createTerminalHost(options);
}

function normalizeTransition(value, model) {
  if (isPromiseLike(value)) throw new TypeError("GTUI update must be synchronous");
  if (value === null || value === undefined) return { model, effects: [] };
  if (!("model" in value) && !("effects" in value)) return { model: value, effects: [] };
  return { model: value.model ?? model, effects: value.effects ?? [] };
}

/**
 * Run a synchronous application against a GTUI host.
 * The application supplies init, update, view, and optional bindings/dispose;
 * update transitions may return effects. GTUI applies messages, renders views,
 * and manages host/task/timer cleanup.
 */
export class GTUI {
  #host;
  #theme;
  #app = null;
  #model;
  #tasks = new Map();
  #timers = new Set();
  #running = false;
  #scheduled = false;
  #frame = null;
  #frameGeneration = 0;
  #resolve;
  #reject;
  #result;
  #bindings;

  /**
   * Create a runtime for a host.
   * @param {{host: object, theme?: object}} options host and optional theme
   */
  constructor({ host, theme = {} } = {}) {
    if (!host) throw new TypeError("GTUI requires a host");
    this.#host = host;
    this.#theme = theme?.resolve ? theme : createTheme(theme, host.capability ?? {});
    host._setTheme?.(this.#theme);
  }

  /**
   * Deliver one message immediately to the running application.
   * @param {object} message application message
   * @returns {void}
   */
  dispatch(message) {
    if (!this.#running) return;
    if (isHostQuit(message)) return this.#finish({ reason: message.reason ?? "input-end", code: message.code ?? 0 });
    this.#apply(message);
  }

  /**
   * Stop the application, canceling tasks and timers and restoring the host.
   * @param {string} [reason="stop"] completion reason
   * @param {number} [code=0] completion code
   * @returns {void}
   */
  stop(reason = "stop", code = 0) {
    if (this.#running) this.#finish({ reason, code });
  }

  /**
   * Start an application and return its eventual completion result.
   * @param {{init?: function, update: function, view: function, bindings?: function, dispose?: function}} app
   * @returns {Promise<{reason: string, code: number}>} completion promise
   */
  run(app) {
    if (this.#running) throw new Error("GTUI is already running");
    if (!app || typeof app.update !== "function" || typeof app.view !== "function") {
      throw new TypeError("GTUI app requires synchronous update and view functions");
    }
    this.#begin(app);
    try {
      const initial = normalizeTransition(app.init?.() ?? { model: {}, effects: [] }, {});
      this.#model = initial.model;
      this.#bindings = compileBindings(this.#app.bindings?.(this.#model) ?? []);
      this.#host._start?.(
        (message) => this.dispatch(message),
        (message) => message?.type === "key" && matchesBinding(this.#bindings, message),
      );
      this.#runEffects(initial.effects);
      if (this.#running) this.#render();
    } catch (error) {
      this.#fail(error);
    }
    return this.#result;
  }

  #begin(app) {
    this.#app = app;
    this.#running = true;
    this.#scheduled = false;
    this.#result = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  #apply(message) {
    try {
      const previous = this.#model;
      const transition = normalizeTransition(this.#app.update(previous, message), previous);
      this.#model = transition.model;
      // Binding functions may construct their list from model state. Compile
      // only at that state boundary, never in the terminal key callback.
      if (transition.model !== previous) this.#bindings = compileBindings(this.#app.bindings?.(this.#model) ?? []);
      this.#runEffects(transition.effects);
      if (!this.#running) return;
      // A resize changes host-owned geometry even when the application keeps
      // the same model object. It must therefore invalidate and repaint just
      // like an input event, rather than waiting for a model identity change.
      const changed = transition.model !== previous
        || message?.type === "resize"
        || message?.type === "menu.change"
        || message?.type === "selection.change"
        || message?.type === "selection.preview"
        || transition.effects.some((value) => value?.type === "refresh");
      if (INTERACTIVE_MESSAGES.has(message?.type)) {
        // A drag preview changes only selection coloring on the mounted
        // canvas. Let the host repaint that scene directly: rebuilding the
        // app view and laying out the transcript is unnecessary hot-path work.
        if (message?.type === "selection.preview" && this.#host._selectionPreview?.()) return;
        // Cancel a coalesced background frame and paint the new focus/control
        // tree now. Without this, Ctrl+X followed by an arrow/Escape in one
        // read still targets the old input, and two printable keys both edit
        // the same stale controlled value.
        this.#cancelScheduledFrame();
        if (changed) this.#render();
      } else if (changed) {
        this.#schedule();
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    const generation = ++this.#frameGeneration;
    this.#frame = setImmediate(() => {
      if (!this.#scheduled || generation !== this.#frameGeneration) return;
      this.#scheduled = false;
      this.#frame = null;
      if (this.#running) this.#render();
    });
  }

  #cancelScheduledFrame() {
    if (this.#frame !== null) clearImmediate(this.#frame);
    this.#frame = null;
    this.#scheduled = false;
    this.#frameGeneration++;
  }

  #render() {
    try {
      const next = this.#app.view(this.#model, this.#theme);
      if (isPromiseLike(next)) throw new TypeError("GTUI view must be synchronous");
      this.#host._render?.(next);
    } catch (error) {
      this.#fail(error);
    }
  }

  #runEffects(values) {
    if (!Array.isArray(values)) throw new TypeError("GTUI effects must be an array");
    for (const value of values) this.#runEffect(value);
  }

  #runEffect(value) {
    if (!value || !this.#running) return;
    if (value.type === "cancel") return this.#cancelTask(value.key);
    if (value.type === "quit") return this.#finish({ reason: "quit", code: value.code });
    if (value.type === "after") return this.#startTimer(value);
    if (value.type === "task") return this.#startTask(value);
    if (value.type === "theme") {
      this.#theme = createTheme(value.tokens ?? {}, this.#host.capability ?? {});
      this.#host._setTheme?.(this.#theme);
      return;
    }
    this.#host._effect?.(value, (message) => this.dispatch(message));
  }

  #cancelTask(key) {
    this.#tasks.get(key)?.abort();
    this.#tasks.delete(key);
  }

  #startTimer({ ms, message }) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.dispatch(message);
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
  }

  #startTask({ key, run }) {
    if (typeof run !== "function") throw new TypeError("GTUI task requires a run function");
    this.#cancelTask(key);
    const controller = new AbortController();
    this.#tasks.set(key, controller);
    void this.#runTask(key, controller, run);
  }

  async #runTask(key, controller, run) {
    try {
      // Yield first: effects are concurrent and never run user task code in
      // the synchronous update/render turn that created them.
      await Promise.resolve();
      const result = await run({ signal: controller.signal, send: (message) => this.#sendTask(controller, message) });
      this.#completeTask(key, controller, result);
    } catch (error) {
      this.#failTask(key, controller, error);
    }
  }

  #sendTask(controller, message) {
    if (!controller.signal.aborted && this.#running) this.dispatch(message);
  }

  #completeTask(key, controller, result) {
    if (controller.signal.aborted || this.#tasks.get(key) !== controller) return;
    this.#tasks.delete(key);
    if (result === undefined) return;
    for (const message of Array.isArray(result) ? result : [result]) this.dispatch(message);
  }

  #failTask(key, controller, error) {
    if (controller.signal.aborted || this.#tasks.get(key) !== controller) return;
    this.#tasks.delete(key);
    this.dispatch(event.taskFailed({ key, error }));
  }

  #cleanup() {
    // Give the app a synchronous chance to resolve its own pending
    // bridges before task cancellation severs their send channels.
    // Restoration must still run if app cleanup itself is faulty.
    try { this.#app?.dispose?.(); } catch { /* best-effort app cleanup */ }
    for (const task of this.#tasks.values()) task.abort();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#tasks.clear();
    this.#timers.clear();
    this.#cancelScheduledFrame();
    this.#running = false;
    this.#host._restore?.();
    // A stopped runtime must not keep the application model/tree reachable.
    // Embedders commonly retain the GTUI instance for status or idempotent
    // stop calls; clearing these references lets transcript/context objects
    // and app closures be collected immediately after teardown.
    this.#app = null;
    this.#model = undefined;
    this.#bindings = undefined;
  }

  #finish(result) {
    this.#cleanup();
    this.#resolve?.(result);
  }

  #fail(error) {
    if (!this.#running) return;
    this.#cleanup();
    this.#reject?.(error);
  }
}

/** Host constructors for tests and terminal execution. */
export const host = freeze({
  /** Create a memory host for deterministic application tests. */
  memory,
  /** Create a terminal host for interactive execution. */
  terminal,
});

/** Return a one-cell grapheme or the supplied fallback. */
export function scrollGlyph(value, fallback) {
  return typeof value === "string" && graphemes(value).length === 1 && graphemeWidth(value) === 1 ? value : fallback;
}
/** Static view-node constructors exposed through TUI.GTUI. */
GTUI.view = view;
/** Static effect constructors exposed through TUI.GTUI. */
GTUI.effect = effect;
/** Static event constructors exposed through TUI.GTUI. */
GTUI.event = event;
/** Static host constructors exposed through TUI.GTUI. */
GTUI.host = host;
/** Keybinding helpers: create/compile contexts, test messages, and normalize keys. */
GTUI.keybindings = freeze({ create: createKeybindings, compile: compileBindings, matches: matchesBinding, canonicalKey, decodeKey });
/** Validate a single-cell scroll glyph. */
GTUI.scrollGlyph = scrollGlyph;
