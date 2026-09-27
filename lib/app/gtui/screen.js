/**
 * lib/app/gtui/screen.js — double-buffered alt-screen frames.
 *
 * Two terminal-sized buffers are reused for the whole session: `front`
 * mirrors what the terminal shows, `back` receives the next frame. Each
 * present paints `back`, diffs it against `front`, and swaps them, so a
 * steady frame allocates no cells. A size change reallocates both once and
 * repaints fully; invalidate() forces a full repaint without reallocating.
 */

import { createBuffer } from "./buffer.js";
import { renderDiff } from "./render.js";

export function createScreen() {
  return { front: null, back: null, known: false };
}

/** Paint the next frame with `paint(back, front)` and return its terminal bytes. */
export function screenPresent(screen, width, height, paint, renderOptions) {
  if (!screen.back || screen.back.w !== width || screen.back.h !== height) {
    screen.back = createBuffer(width, height);
    screen.front = createBuffer(width, height);
    screen.known = false;
  }
  paint(screen.back, screen.front);
  const bytes = renderDiff(screen.back, screen.known ? screen.front : null, renderOptions);
  const shown = screen.back;
  screen.back = screen.front;
  screen.front = shown;
  screen.known = true;
  return bytes;
}

/** The terminal no longer matches `front` (resize, refresh): repaint fully next. */
export function screenInvalidate(screen) {
  screen.known = false;
}

/** Drop both buffers (session end). */
export function screenRelease(screen) {
  screen.front = null;
  screen.back = null;
  screen.known = false;
}
