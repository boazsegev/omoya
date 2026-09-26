import { spawn } from "node:child_process";
import { createControls } from "./controls.js";
import { cloneBuffer } from "./buffer.js";
import { layoutView } from "./layout.js";
import { decodeMouse } from "./mouse.js";
import { renderDiff } from "./render.js";
import { createTerminalInput } from "./terminal-input.js";
import { createInlineTerminalRenderer } from "./terminal-inline-host.js";
import { copyToClipboard } from "./clipboard.js";
import { sceneBuffer } from "./scene-buffer.js";
import { compileAnimations, disposeCompiledAnimations, scheduleCompiledAnimations } from "./animation-scheduler.js";
import {
  CURSOR_HIDE, CURSOR_SHOW, DISABLE_MOUSE, ENABLE_MOUSE, SYNC_END, SYNC_START,
  backgroundColor, cursorColor, cursorStyle, cursorStyleReset, notificationBytes, titleBytes,
} from "./term.js";
import {
  DISABLE_KITTY_KEYS, DISABLE_MODIFY_OTHER_KEYS, DISABLE_PASTE,
  ENABLE_KITTY_KEYS, ENABLE_MODIFY_OTHER_KEYS, ENABLE_PASTE,
} from "./byte-filter.js";

const ALT_ENTER = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_LEAVE = "\x1b[?1049l";
const RESET = "\x1b[0m";

function dimensions(output, options) {
  const value = (candidate, fallback) => Math.max(1, Number(typeof candidate === "function" ? candidate() : candidate) || fallback);
  return { width: value(options.columns ?? output?.columns, 80), height: value(options.rows ?? output?.rows, 24) };
}

function rawPointer(controls, mouse) {
  const point = { x: mouse.x - 1, y: mouse.y - 1 };
  const resolved = controls.resolvePoint(point, { wheel: Boolean(mouse.wheel) }) ?? {};
  if (mouse.wheel) return { type: "pointer", ...resolved, ...point, kind: "wheel", direction: mouse.wheel };
  const kind = mouse.release ? "release" : mouse.move ? "move" : mouse.drag ? "drag" : "press";
  // Keep blank-area drag/release events: an active selection may end
  // outside the glyph/control where it started.
  return { type: "pointer", ...resolved, ...point, kind, button: mouse.button };
}

function openExternalUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.href] : [url.href];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {});
    return true;
  } catch { return false; }
}

function setRaw(input, enabled) {
  if (input?.isTTY && typeof input.setRawMode === "function") input.setRawMode(enabled);
  if (enabled) input?.resume?.();
  else input?.pause?.();
}

/** Generic terminal host. Alt owns an alternate screen and absolute cell diffing. */
export function createTerminalHost(options = {}) {
  const { input, output, mode = "inline", title = "", signals } = options;
  if (!input || !output || typeof output.write !== "function") throw new TypeError("terminal host requires input and output streams");
  if (mode !== "alt" && mode !== "inline") throw new TypeError(`unsupported terminal mode: ${mode}`);
  const mouse = options.mouse ?? (mode === "alt" ? "always" : "overlays");
  if (!["overlays", "always", "off"].includes(mouse)) throw new TypeError(`unsupported mouse policy: ${mouse}`);
  const state = { listener: null, binding: null, cleanupInput: null, inputEnd: null, resize: null, signalHandlers: [], prev: null, scene: null, controls: null, started: false, restored: false, theme: null, renderInline: null, lastRoot: null, animationTimer: null, animation: null, animationGeneration: 0, cursorTimer: null, cursorConfig: null, cursorVisible: false, renderBurst: false, queuedRender: false, frameBytes: null };
  const write = (bytes) => {
    if (!bytes) return;
    if (state.frameBytes) { state.frameBytes.push(bytes); return; }
    output.write(bytes);
  };
  const scrollBar = mode === "alt" && options.scrollBar?.show !== false
    ? { track: options.scrollBar?.track ?? "│", thumb: options.scrollBar?.thumb ?? "█" }
    : null;
  const controls = createControls((message) => state.listener?.(message), { scrollBar });
  state.controls = controls;
  const inline = mode === "inline" ? createInlineTerminalRenderer({ write, rows: () => dimensions(output, options).height, controls, mouse }) : null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const animationInterval = Math.max(16, Number(options.animationInterval) || 50);
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;

  function disposeAnimation() {
    if (state.animation) disposeCompiledAnimations(state.animation);
    state.animation = null;
    state.animationGeneration++;
  }

  function animationPaint(sink, buffer) {
    if (!sink.active || sink.scheduler?.disposed) return;
    const bytes = renderDiff(buffer, sink.prev, { cursorBytes: sink.cursorBytes });
    if (bytes) sink.output.write(SYNC_START + bytes + SYNC_END);
    sink.prev = cloneBuffer(buffer);
  }

  function mountAnimations(time) {
    disposeAnimation();
    const compiled = compileAnimations(state.scene, state.theme, { time, sampleMs: animationInterval });
    // The timer graph is deliberately narrow: compiled cells/styles plus this
    // sink (output, prior terminal buffer, cursor bytes, active flag). It does
    // not retain host state, lastRoot, controls, or the application model.
    const sink = { output, prev: state.prev, cursorBytes: cursorBytes(state.scene.canvas.caret), active: true, scheduler: null, paint: animationPaint };
    const scheduler = {
      compiled, sink, timer: null, disposed: false, generation: state.animationGeneration,
      expectedGeneration: state.animationGeneration, now, setTimeout: scheduleTimeout, clearTimeout: cancelTimeout,
    };
    sink.scheduler = scheduler;
    state.animation = scheduler;
    return scheduler;
  }

  function cursorConfig(caret) {
    const requested = caret?.cursor && typeof caret.cursor === "object" ? caret.cursor : {};
    const themed = state.theme?.cursor ?? {};
    const rawBlink = requested.blinkMs ?? themed.blinkMs ?? options.cursorBlinkMs ?? options.cursorBlink;
    const blinkMs = rawBlink === false ? false : (Number.isFinite(Number(rawBlink)) && Number(rawBlink) > 0 ? Number(rawBlink) : 450);
    return { shape: requested.shape ?? themed.shape ?? options.cursorShape ?? "line", color: themed.color, blinkMs };
  }

  function cursorBytes(caret) {
    if (!caret) {
      state.cursorConfig = null;
      state.cursorVisible = false;
      return CURSOR_HIDE;
    }
    const config = cursorConfig(caret);
    state.cursorConfig = config;
    state.cursorVisible = config.blinkMs === false || Math.floor(now() / config.blinkMs) % 2 === 0;
    // Blink timing is host-owned so an input can request an exact
    // half-period rather than accepting the terminal's global blink rate.
    return cursorStyle(config.shape, false) + cursorColor(config.color) + (state.cursorVisible ? CURSOR_SHOW : CURSOR_HIDE);
  }

  function scheduleCursorBlink() {
    if (state.cursorTimer) cancelTimeout(state.cursorTimer);
    state.cursorTimer = null;
    const config = state.cursorConfig;
    if (!config || config.blinkMs === false || !state.started || state.restored) return;
    const elapsed = now() % config.blinkMs;
    const delay = Math.max(1, config.blinkMs - elapsed);
    state.cursorTimer = scheduleTimeout(() => {
      state.cursorTimer = null;
      if (!state.started || state.restored || !state.cursorConfig) return;
      state.cursorVisible = !state.cursorVisible;
      write(state.cursorVisible ? CURSOR_SHOW : CURSOR_HIDE);
      scheduleCursorBlink();
    }, delay);
    state.cursorTimer.unref?.();
  }

  function repaintSelection() {
    if (mode !== "alt" || !state.scene) return false;
    const scheduler = mountAnimations(now());
    const buffer = scheduler.compiled.buffer;
    const bytes = renderDiff(buffer, state.prev, { cursorBytes: cursorBytes(state.scene.canvas.caret) });
    if (bytes) write(SYNC_START + bytes + SYNC_END);
    state.prev = cloneBuffer(buffer);
    scheduler.sink.prev = state.prev;
    return true;
  }

  function paint(root, { animationOnly = false } = {}) {
    const size = dimensions(output, options);
    const time = now();
    if (mode === "inline") {
      // Inline renderers produce relative repaint bytes plus a separate cursor
      // update. Commit them as one physical write, especially after a raw
      // input burst, so the terminal never observes an intermediate frame.
      state.frameBytes = [];
      try {
        const active = animationOnly
          ? inline.animate(state.theme, time)
          : inline.render(root, state.theme, size, time);
        write(cursorBytes(inline.caret));
        const bytes = state.frameBytes.join("");
        if (bytes) output.write(bytes);
        scheduleCursorBlink();
        return active;
      } finally {
        // A view/render throw is handled by GTUI's failure path, which must
        // write terminal teardown directly rather than into a stale frame.
        state.frameBytes = null;
      }
    }
    // Alt animation wakes only mutate styles in their mounted buffer; they
    // never relayout or allocate a replacement full-screen paint buffer.
    if (animationOnly && state.animation) return state.animation.compiled.targets.length > 0;
    state.scene = layoutView(root, { ...size, controls, theme: state.theme });
    const scheduler = mountAnimations(time);
    const buffer = scheduler.compiled.buffer;
    const bytes = renderDiff(buffer, state.prev, { cursorBytes: cursorBytes(state.scene.canvas.caret) });
    if (bytes) write(SYNC_START + bytes + SYNC_END);
    state.prev = cloneBuffer(buffer);
    scheduler.sink.prev = state.prev;
    scheduleCursorBlink();
    return scheduler.compiled.targets.length > 0;
  }

  function scheduleAnimation(active) {
    if (mode === "alt") {
      if (active && state.started && !state.restored && state.animation) scheduleCompiledAnimations(state.animation);
      return;
    }
    if (state.animationTimer) cancelTimeout(state.animationTimer);
    state.animationTimer = null;
    if (!active || !state.started || state.restored) return;
    state.animationTimer = scheduleTimeout(() => {
      state.animationTimer = null;
      if (!state.started || state.restored || !state.lastRoot) return;
      scheduleAnimation(paint(state.lastRoot, { animationOnly: true }));
    }, animationInterval);
    state.animationTimer.unref?.();
  }

  const host = {
    capability: { colorfgbg: options.colorfgbg },
    _selectionPreview() {
      if (mode !== "alt" || !state.scene) return false;
      controls.applySelection(state.scene.canvas);
      return repaintSelection();
    },
    _pointerPreview() { return repaintSelection(); },
    _setTheme(theme) {
      state.theme = theme;
      // Themes can change while the TUI is open from the Theme menu. OSC 11
      // is advisory (unsupported terminals ignore it); only alt owns enough
      // terminal surface to safely recolor the complete canvas.
      if (mode === "alt" && state.started && !state.restored) write(backgroundColor(theme?.resolve?.("background")?.bg));
    },
    _start(listener, binding) {
      if (state.started) return;
      state.started = true;
      state.restored = false;
      state.listener = listener;
      state.binding = binding;
      setRaw(input, true);
      // Keyboard/paste/mouse modes are screen-stack state in terminals
      // that implement save/restore around 1049. Enter alt FIRST, then
      // enable modes on that screen; teardown performs the exact reverse.
      const canvas = mode === "alt" ? backgroundColor(state.theme?.resolve?.("background")?.bg) : "";
      const start = (mode === "alt" ? ALT_ENTER : "") + canvas + ENABLE_PASTE + ENABLE_KITTY_KEYS + ENABLE_MODIFY_OTHER_KEYS + (mode === "alt" && mouse !== "off" ? ENABLE_MOUSE : "") + CURSOR_HIDE + cursorStyle(options.cursorShape ?? "line", false);
      write(start + (title ? titleBytes(title) : ""));
      state.cleanupInput = createTerminalInput(input, (message) => {
        const event = message.type === "pointer.raw" ? rawPointer(controls, message.mouse) : message;
        if (!event) return;
        if (event.type === "pointer" && event.kind === "move" && controls.handle(event)) {
          host._pointerPreview();
          return;
        }
        if (state.binding?.(event) || !controls.handle(event)) state.listener?.(event);
      }, {
        // Each raw input chunk may decode into several keys. GTUI still mounts
        // every controlled state synchronously between those keys, while the
        // host holds their terminal bytes until the complete chunk is handled.
        beginBurst: () => { state.renderBurst = true; },
        endBurst: () => {
          state.renderBurst = false;
          if (!state.queuedRender) return;
          state.queuedRender = false;
          // An event in this chunk may synchronously stop the UI. Never
          // resurrect output after restoration merely because it was preceded
          // by a render-worthy key in that same chunk.
          if (state.started && !state.restored && state.lastRoot) scheduleAnimation(paint(state.lastRoot));
        },
      });
      state.resize = () => {
        disposeAnimation();
        state.scene = null;
        if (mode === "inline") inline.refresh();
        else state.prev = null;
        listener({ type: "resize", ...dimensions(output, options) });
      };
      output.on?.("resize", state.resize);
      if (signals?.on) {
        for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
          const handler = () => listener({ type: "host.quit", reason: "signal", signal: name, code: name === "SIGINT" ? 130 : 1 });
          signals.on(name, handler);
          state.signalHandlers.push([name, handler]);
        }
      }
      state.inputEnd = () => listener({ type: "host.quit", reason: "input-end", code: 0 });
      input.once?.("end", state.inputEnd);
    },
    _render(root, theme) {
      state.theme = theme ?? state.theme;
      state.lastRoot = root;
      // Input controls still receive every decoded key synchronously, so
      // controlled values/focus are current for the next key in this chunk.
      // Only the physical frame waits for the chunk boundary.
      if (state.renderBurst) {
        // Mount the latest control tree now so the next decoded key in this
        // same raw chunk edits its current controlled value, not the prior
        // frame. The final paint below is still the sole terminal write.
        if (mode === "inline") {
          // Inline's renderer owns feed commits and its private scene; mount
          // controls without writing so the next key sees current state.
          layoutView(root, { ...dimensions(output, options), controls, theme: state.theme });
          state.queuedRender = true;
          return;
        }
        disposeAnimation();
        state.scene = layoutView(root, { ...dimensions(output, options), controls, theme: state.theme });
        state.queuedRender = true;
        return;
      }
      scheduleAnimation(paint(root));
    },
    _effect(effect, send) {
      if (effect.type === "refresh") { disposeAnimation(); state.prev = null; state.scene = null; inline?.refresh(); }
      if (effect.type === "notify") write(notificationBytes(effect.text));
      if (effect.type === "open") (options.openUrl ?? openExternalUrl)(effect.url);
      if (effect.type === "copy") {
        copyToClipboard(effect.text, { write, osc52: options.osc52 !== false })
          .then((ok) => send?.({ type: "copy.done", id: effect.id, ok }))
          .catch(() => send?.({ type: "copy.done", id: effect.id, ok: false }));
      }
    },
    _restore() {
      if (state.restored) return;
      state.restored = true;
      state.cleanupInput?.();
      input.off?.("end", state.inputEnd);
      state.inputEnd = null;
      output.off?.("resize", state.resize);
      for (const [name, handler] of state.signalHandlers) signals?.off?.(name, handler);
      state.signalHandlers = [];
      if (state.animationTimer) cancelTimeout(state.animationTimer);
      state.animationTimer = null;
      if (state.animation?.sink) state.animation.sink.active = false;
      disposeAnimation();
      if (state.cursorTimer) cancelTimeout(state.cursorTimer);
      state.cursorTimer = null;
      state.cursorConfig = null;
      state.lastRoot = null;
      state.queuedRender = false;
      state.renderBurst = false;
      inline?.leave();
      const end = RESET + CURSOR_SHOW + cursorColor(null) + (mode === "alt" ? backgroundColor(null) : "") + cursorStyleReset() + (mode === "alt" && mouse !== "off" ? DISABLE_MOUSE : "") + DISABLE_PASTE + DISABLE_KITTY_KEYS + DISABLE_MODIFY_OTHER_KEYS + (mode === "alt" ? ALT_LEAVE : "");
      write(end);
      setRaw(input, false);
      state.listener = null;
      state.binding = null;
      controls.dispose();
      state.prev = null;
      state.scene = null;
      state.started = false;
    },
    _installInline(renderer) { state.renderInline = renderer; },
    _write: write,
  };
  return Object.freeze(host);
}

export const terminalHostInternals = Object.freeze({ sceneBuffer, rawPointer, dimensions, openExternalUrl, ALT_ENTER, ALT_LEAVE });
