/**
 * GTUI public façade for synchronous terminal applications.
 *
 * GTUI owns view geometry, rendering, terminal controls, selection, editing,
 * and key decoding. Applications own semantic policy and conversation state;
 * TUI turn lifecycle remains in lib/app/tui/. Hosts provide terminal I/O and
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

/** Freeze and return a value.
 * @param {*} value value to freeze
 * @returns {*} the same frozen value
 */
const freeze = (value) => Object.freeze(value);
/** Create a node-constructor for the supplied type.
 * @param {string} type node type
 * @returns {Function} constructor accepting optional props and children
 */
const node = (type) => (props = {}, children = []) => freeze({
  type,
  ...props,
  children: freeze(Array.isArray(children) ? [...children] : [children]),
});
/** Create a frozen message object.
 * @param {string} type event type
 * @param {object} [payload={}] fields copied onto the event
 * @returns {object} frozen event
 */
const makeEvent = (type, payload = {}) => freeze({ type, ...payload });
/** Test whether a value has a callable then property.
 * @param {*} value value to test
 * @returns {boolean} whether it is object-like and thenable
 */
const isPromiseLike = (value) => value !== null && typeof value === "object" && typeof value.then === "function";
/** Identify the private host-level shutdown message. Window lifecycle is a host-only protocol: menu actions may legitimately use the ordinary words "back" and "close"; they are app messages, never instructions to tear down the terminal.
 * @param {object|null|undefined} message incoming message
 * @returns {boolean} whether the host requests shutdown
 */
const isHostQuit = (message) => message?.type === "host.quit";
// Terminal interaction is sequential state, not a background stream: a
// control opened by one key must be mounted before the next key from the
// same input chunk is decoded. Provider/task messages coalesce to one
// cancellable event-loop frame, leaving input I/O a chance to run.
const INTERACTIVE_MESSAGES = new Set([
  "key", "paste", "pointer", "resize", "focus", "selection.copy",
  "input.change", "input.scroll", "input.submit", "menu.change", "menu.select", "menu.cancel", "action.select", "toolbar.change", "link.open", "selection.change", "selection.preview",
]);

/** Immutable constructors for renderable view nodes. */
export const view = freeze({
  /** Create immutable text content.
   * @param {object} [props={}] text-node properties
   * @param {*} [content=""] text content
   * @returns {object} frozen text node
   */
  text: (props = {}, content = "") => freeze({ type: "text", ...props, content }),
  /** Create an immutable table with frozen rows and cells.
   * @param {object} [props={}] table properties
   * @param {object[]} [rows=[]] rows; each row's cells are copied and frozen
   * @returns {object} frozen table node
   */
  table: (props = {}, rows = []) => freeze({ type: "table", ...props, rows: freeze([...rows].map((row) => freeze({ ...row, cells: freeze((row.cells ?? []).map((cell) => freeze([...cell]))) }))) }),
  /** Create an immutable horizontal container.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen row node
   */
  row: node("row"),
  /** Create an immutable vertical container.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen column node
   */
  column: node("column"),
  /** Create an immutable grid container.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen grid node
   */
  grid: node("grid"),
  /** Create an immutable bordered panel.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen panel node
   */
  panel: node("panel"),
  /** Create an immutable feed control.
   * @param {object} [props={}] feed properties
   * @returns {object} frozen feed node
   */
  feed: (props = {}) => freeze({ type: "feed", ...props }),
  /** Create an immutable scroll container.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen scroll node
   */
  scroll: node("scroll"),
  /** Create an immutable overlay container.
   * @param {object} [props={}] node properties
   * @param {Array|*} [children=[]] child nodes
   * @returns {object} frozen overlay node
   */
  overlay: node("overlay"),
  /** Create an immutable text input control.
   * @param {object} [props={}] input properties
   * @returns {object} frozen input node
   */
  input: (props = {}) => freeze({ type: "input", ...props }),
  /** Create an immutable menu control.
   * @param {object} [props={}] menu properties
   * @returns {object} frozen menu node
   */
  menu: (props = {}) => freeze({ type: "menu", ...props }),
  /** Create a horizontal toolbar container with host-owned roving focus.
   * Children use `{id, focus, gap?, align?: "end"}`; while focused, navigation
   * keys move focus and Enter/Space activate; other keys bubble.
   * @param {object} [props={}] toolbar properties
   * @param {Array|*} [children=[]] button children
   * @returns {object} frozen toolbar node
   */
  toolbar: node("toolbar"),
  /** Create a button node; activation emits `action.select {id, action}`.
   * `pressed` styles an on toggle and `tone` adds a role.
   * @param {object} [props={}] button properties
   * @param {*} [label=""] label converted to a string
   * @returns {object} frozen button node
   */
  button: (props = {}, label = "") => freeze({ type: "button", ...props, content: String(label) }),
  /** Build a one-line footer of app-pushed notification items, aligned start/end;
   * tight rows drop lowest priority first. Empty items yield null.
   * @param {object} [props={}] row properties
   * @param {Array<object>} [items=[]] items with text and optional role, priority, align, action
   * @returns {object|null} frozen footer row, or null when empty
   */
  footer: (props = {}, items = []) => {
    if (items.length === 0) return null;
    /** Build frozen footer text items for one alignment.
     * @param {string} align alignment key
     * @returns {object[]} footer text nodes
     */
    const side = (align) => items.filter((item) => (item.align ?? "start") === align).map((item, index) => freeze({
      type: "text", margin: 0, overflow: "clip-end", priority: item.priority ?? 0, role: item.role ?? "muted",
      ...(item.action ? { action: item.action } : {}),
      content: `${index > 0 ? " · " : ""}${item.text}`,
    }));
    return freeze({ type: "row", ...props, columns: ["fill", "auto"], children: freeze([
      freeze({ type: "row", children: freeze(side("start")) }),
      freeze({ type: "row", children: freeze(side("end")) }),
    ]) });
  },
});

/** Immutable constructors for host, task, timer, theme, and lifecycle effects. */
export const effect = freeze({
  /** Describe an abortable asynchronous task.
   * @param {*} key task identity
   * @param {Function} run async task receiving signal and send
   * @returns {object} frozen task effect
   */
  task: (key, run) => freeze({ type: "task", key, run }),
  /** Describe cancellation of a keyed task.
   * @param {*} key task identity
   * @returns {object} frozen cancellation effect
   */
  cancel: (key) => freeze({ type: "cancel", key }),
  /** Describe delayed message delivery.
   * @param {number} ms delay in milliseconds
   * @param {object} message message to dispatch
   * @returns {object} frozen timer effect
   */
  after: (ms, message) => freeze({ type: "after", ms, message }),
  /** Request host-mediated text copying.
   * @param {string} text text to copy
   * @param {*} [id] optional correlation identifier
   * @returns {object} frozen copy effect
   */
  copy: (text, id) => freeze({ type: "copy", text, ...(id === undefined ? {} : { id }) }),
  /** Request host-mediated URL opening.
   * @param {string} url URL to open
   * @returns {object} frozen open effect
   */
  open: (url) => freeze({ type: "open", url }),
  /** Request a host notification.
   * @param {string} text notification text
   * @returns {object} frozen notification effect
   */
  notify: (text) => freeze({ type: "notify", text }),
  /** Replace theme tokens at runtime.
   * @param {object} tokens theme token mapping
   * @returns {object} frozen theme effect
   */
  theme: (tokens) => freeze({ type: "theme", tokens }),
  /** Request a render without changing the model.
   * @returns {object} frozen refresh effect
   */
  refresh: () => freeze({ type: "refresh" }),
  /** Request application shutdown.
   * @param {number} [code=0] completion status code
   * @returns {object} frozen quit effect
   */
  quit: (code = 0) => freeze({ type: "quit", code }),
});

/** Immutable constructors for messages delivered to an application update function. */
export const event = freeze({
  /** Create a key event.
   * @param {object} payload event fields
   * @returns {object} frozen key event
   */
  key: (payload) => makeEvent("key", payload),
  /** Create a paste event.
   * @param {object} payload event fields
   * @returns {object} frozen paste event
   */
  paste: (payload) => makeEvent("paste", payload),
  /** Create a pointer event.
   * @param {object} payload event fields
   * @returns {object} frozen pointer event
   */
  pointer: (payload) => makeEvent("pointer", payload),
  /** Create a resize event.
   * @param {object} payload event fields
   * @returns {object} frozen resize event
   */
  resize: (payload) => makeEvent("resize", payload),
  /** Create a focus event.
   * @param {object} payload event fields
   * @returns {object} frozen focus event
   */
  focus: (payload) => makeEvent("focus", payload),
  /** Create an input-change event.
   * @param {object} payload event fields
   * @returns {object} frozen input-change event
   */
  inputChange: (payload) => makeEvent("input.change", payload),
  /** Create an input-submit event.
   * @param {object} payload event fields
   * @returns {object} frozen input-submit event
   */
  inputSubmit: (payload) => makeEvent("input.submit", payload),
  /** Create a menu-selection event.
   * @param {object} payload event fields
   * @returns {object} frozen menu-selection event
   */
  menuSelect: (payload) => makeEvent("menu.select", payload),
  /** Create a menu-cancel event.
   * @param {object} [payload={}] event fields
   * @returns {object} frozen menu-cancel event
   */
  menuCancel: (payload = {}) => makeEvent("menu.cancel", payload),
  /** Create a selection-copy event.
   * @param {object} payload event fields
   * @returns {object} frozen selection-copy event
   */
  selectionCopy: (payload) => makeEvent("selection.copy", payload),
  /** Create a link-open event.
   * @param {object} payload event fields
   * @returns {object} frozen link-open event
   */
  linkOpen: (payload) => makeEvent("link.open", payload),
  /** Create a completed-task event.
   * @param {object} payload event fields
   * @returns {object} frozen task-done event
   */
  taskDone: (payload) => makeEvent("task.done", payload),
  /** Create a failed-task event.
   * @param {object} payload event fields
   * @returns {object} frozen task-failed event
   */
  taskFailed: (payload) => makeEvent("task.failed", payload),
  /** Create a completed-copy event.
   * @param {object} payload event fields
   * @returns {object} frozen copy-done event
   */
  copyDone: (payload) => makeEvent("copy.done", payload),
});

/** Create an in-memory host for application tests. It records rendered
 * semantics and effects; it never emits terminal bytes.
 * @param {{width?: number, height?: number, scrollBar?: object}} [options={}] host dimensions and scrollbar policy
 * @returns {object} in-memory host implementing the GTUI host protocol
 */
export function memory({ width = 80, height = 24, scrollBar } = {}) {
  const state = { width, height, view: null, scene: null, effects: [], listener: null, binding: null, restoreCount: 0, controls: null, theme: null };
  state.controls = createControls((message) => state.listener?.(message), { scrollBar });
  return freeze({
    /** Send a host input message to the mounted application.
     * @param {object} message input message
     * @returns {void}
     */
    send(message) {
      if (state.binding?.(message) || !state.controls.handle(message)) state.listener?.(message);
    },
    /** Finish pending host output; memory hosts have nothing to flush.
     * @returns {void}
     */
    flush() {},
    /** Return the current rendered scene in semantic, testable form.
     * @returns {object} scene snapshot with current dimensions
     */
    snapshot() {
      const snapshot = state.scene?.snapshot ?? { lines: [], roles: [], links: [], sources: [], focus: null, caret: null };
      return { ...snapshot, width: state.width, height: state.height };
    },
    /** Recorded effects, copied so callers cannot mutate host state.
     * @returns {object[]} shallow copy of recorded effects
     */
    get effects() { return [...state.effects]; },
    /** Number of completed host restoration cycles.
     * @returns {number} restoration count
     */
    get restoreCount() { return state.restoreCount; },
    /** Start the runtime-to-host message protocol.
     * @param {Function} listener callback for incoming messages
     * @param {Function} binding predicate for bound key messages
     * @returns {void}
     */
    _start(listener, binding) { state.listener = listener; state.binding = binding; },
    /** Render a view through the in-memory layout engine.
     * @param {object} next view tree
     * @returns {void}
     */
    _render(next) {
      state.view = next;
      state.scene = layoutView(next, { width: state.width, height: state.height, controls: state.controls, theme: state.theme });
    },
    /** Install the resolved theme for subsequent layouts.
     * @param {object} theme resolved theme
     * @returns {void}
     */
    _setTheme(theme) { state.theme = theme; },
    /** Record an effect and acknowledge copy effects asynchronously.
     * @param {object} value effect descriptor
     * @param {Function} [send] callback receiving the copy acknowledgement
     * @returns {void}
     * @effects Schedules a microtask acknowledgement for copy effects.
     */
    _effect(value, send) {
      state.effects.push(value);
      if (value.type === "copy") queueMicrotask(() => send?.(event.copyDone({ id: value.id, ok: true })));
    },
    /** Clear runtime callbacks and record host restoration.
     * @returns {void}
     */
    _restore() {
      state.listener = null;
      state.binding = null;
      state.restoreCount++;
    },
  });
}

/** Construct a terminal host that owns input decoding and terminal rendering,
 * or return `options.host` unchanged.
 * @param {object} [options={}] terminal streams, mode, dimensions, and policies
 * @returns {object} supplied or newly-created GTUI host
 */
export function terminal(options = {}) {
  if (options.host) return options.host;
  return createTerminalHost(options);
}

/** Normalize an update/init return value into model plus effect list.
 * @param {*} value transition, replacement model, nullish value, or promise
 * @param {*} model prior model used for omitted values
 * @returns {{model: *, effects: Array}} normalized synchronous transition
 * @throws {TypeError} when value is promise-like
 */
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
  #tokens = {};
  #resolve;
  #reject;
  #result;
  #bindings;

  /**
   * Create a runtime for a host.
   * @param {{host: object, theme?: object}} [options={}] host and optional theme
   * @returns {GTUI} configured runtime
   * @throws {TypeError} if host is missing
   */
  constructor({ host, theme = {} } = {}) {
    if (!host) throw new TypeError("GTUI requires a host");
    this.#host = host;
    this.#theme = theme?.resolve ? theme : createTheme(theme, host.capability ?? {});
    host._setTheme?.(this.#theme);
    host._onAppearanceChange?.(() => {
      if (this.#tokens === null) return;
      this.#theme = createTheme(this.#tokens, host.capability ?? {});
      host._setTheme?.(this.#theme);
      if (this.#running) this.#render();
    });
    this.#tokens = theme?.resolve ? null : theme;
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
   * @param {{init?: Function, update: Function, view: Function, bindings?: Function, dispose?: Function}} app application callbacks
   * @returns {Promise<{reason: string, code: number}>} completion promise; rejects on runtime failure
   * @throws {Error} if already running; TypeError if required callbacks are absent
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

  /** Initialize per-run runtime state and completion promise.
   * @param {object} app application callbacks
   * @returns {void}
   */
  #begin(app) {
    this.#app = app;
    this.#running = true;
    this.#scheduled = false;
    this.#result = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /** Apply an update, effects, and the necessary immediate/deferred render.
   * @param {object} message application message
   * @returns {void}
   * @effects May run effects, schedule rendering, or fail and clean up the run.
   */
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
        || message?.type === "input.scroll"
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

  /** Coalesce a background render into one cancellable event-loop turn.
   * @returns {void}
   */
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

  /** Cancel any coalesced render and invalidate its callback generation.
   * @returns {void}
   */
  #cancelScheduledFrame() {
    if (this.#frame !== null) clearImmediate(this.#frame);
    this.#frame = null;
    this.#scheduled = false;
    this.#frameGeneration++;
  }

  /** Build the application view and send it to the host; failures end the run.
   * @returns {void}
   * @throws {TypeError} if the app view returns a promise-like value
   */
  #render() {
    try {
      const next = this.#app.view(this.#model, this.#theme);
      if (isPromiseLike(next)) throw new TypeError("GTUI view must be synchronous");
      this.#host._render?.(next);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Apply a list of effects in order.
   * @param {Array} values effects to apply
   * @returns {void}
   * @throws {TypeError} if values is not an array
   */
  #runEffects(values) {
    if (!Array.isArray(values)) throw new TypeError("GTUI effects must be an array");
    for (const value of values) this.#runEffect(value);
  }

  /** Apply one effect, including task/timer/theme handling or host delegation.
   * @param {object} value effect descriptor
   * @returns {void}
   */
  #runEffect(value) {
    if (!value || !this.#running) return;
    if (value.type === "cancel") return this.#cancelTask(value.key);
    if (value.type === "quit") return this.#finish({ reason: "quit", code: value.code });
    if (value.type === "after") return this.#startTimer(value);
    if (value.type === "task") return this.#startTask(value);
    if (value.type === "theme") {
      this.#tokens = value.tokens ?? {};
      this.#theme = createTheme(this.#tokens, this.#host.capability ?? {});
      this.#host._setTheme?.(this.#theme);
      return;
    }
    this.#host._effect?.(value, (message) => this.dispatch(message));
  }

  /** Abort and remove the task registered under a key.
   * @param {*} key task identity
   * @returns {void}
   */
  #cancelTask(key) {
    this.#tasks.get(key)?.abort();
    this.#tasks.delete(key);
  }

  /** Schedule a delayed application message and track its timer for cleanup.
   * @param {{ms: number, message: object}} timer delay effect
   * @returns {void}
   */
  #startTimer({ ms, message }) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.dispatch(message);
    }, ms);
    timer.unref?.();
    this.#timers.add(timer);
  }

  /** Start or replace an abortable asynchronous task.
   * @param {{key: *, run: Function}} task task descriptor
   * @returns {void}
   * @throws {TypeError} if run is not a function
   */
  #startTask({ key, run }) {
    if (typeof run !== "function") throw new TypeError("GTUI task requires a run function");
    this.#cancelTask(key);
    const controller = new AbortController();
    this.#tasks.set(key, controller);
    void this.#runTask(key, controller, run);
  }

  /** Run user task code asynchronously and report its completion or failure.
   * @param {*} key task identity
   * @param {AbortController} controller task cancellation controller
   * @param {Function} run user task function
   * @returns {Promise<void>} settles after task processing
   */
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

  /** Dispatch a task message only while its controller and runtime remain active.
   * @param {AbortController} controller task controller
   * @param {object} message message to dispatch
   * @returns {void}
   */
  #sendTask(controller, message) {
    if (!controller.signal.aborted && this.#running) this.dispatch(message);
  }

  /** Dispatch task result message(s) if this task is still current.
   * @param {*} key task identity
   * @param {AbortController} controller task controller
   * @param {*} result one message, message array, or undefined
   * @returns {void}
   */
  #completeTask(key, controller, result) {
    if (controller.signal.aborted || this.#tasks.get(key) !== controller) return;
    this.#tasks.delete(key);
    if (result === undefined) return;
    for (const message of Array.isArray(result) ? result : [result]) this.dispatch(message);
  }

  /** Dispatch a task-failed event if this task is still current.
   * @param {*} key task identity
   * @param {AbortController} controller task controller
   * @param {*} error task rejection value
   * @returns {void}
   */
  #failTask(key, controller, error) {
    if (controller.signal.aborted || this.#tasks.get(key) !== controller) return;
    this.#tasks.delete(key);
    this.dispatch(event.taskFailed({ key, error }));
  }

  /** Dispose app state, cancel work, restore host, and release app references.
   * @returns {void}
   * @effects Aborts tasks, clears timers, and calls host restoration.
   */
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

  /** Complete the run normally after cleanup.
   * @param {{reason: string, code: number}} result completion result
   * @returns {void}
   */
  #finish(result) {
    this.#cleanup();
    this.#resolve?.(result);
  }

  /** Reject the run after cleanup if it is still active.
   * @param {*} error failure reason
   * @returns {void}
   */
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

/** Validate a one-cell grapheme for use as a scroll indicator.
 * @param {*} value candidate glyph
 * @param {*} fallback result when candidate is invalid
 * @returns {*} candidate when it is a one-cell grapheme, otherwise fallback
 */
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
/** Keybinding helpers: create/compile contexts, test messages, and normalize keys.
 * @returns {object} frozen helper collection (`create`, `compile`, `matches`, `canonicalKey`, `decodeKey`)
 */
GTUI.keybindings = freeze({ create: createKeybindings, compile: compileBindings, matches: matchesBinding, canonicalKey, decodeKey });
/** Validate a single-cell scroll glyph. */
GTUI.scrollGlyph = scrollGlyph;
