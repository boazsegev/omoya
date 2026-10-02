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

/**
 * Create the mutable state for a double-buffered terminal screen.
 * @returns {{front: ReturnType<typeof createBuffer>|null, back: ReturnType<typeof createBuffer>|null, known: boolean}} Empty buffers and an unknown terminal image.
 */
export function createScreen() {
  return { front: null, back: null, known: false };
}

/**
 * Paint and encode the next screen frame, then swap the front and back buffers.
 * Resizes allocate fresh buffers and force a full repaint; an unknown front also
 * forces a full repaint. Calls `paint(back, front)` and delegates encoding to
 * `renderDiff`.
 * @param {ReturnType<typeof createScreen>} screen Mutable screen state.
 * @param {number} width Buffer width in terminal cells.
 * @param {number} height Buffer height in terminal cells.
 * @param {(back: ReturnType<typeof createBuffer>, front: ReturnType<typeof createBuffer>) => void} paint Callback that updates the back buffer, optionally using the front buffer.
 * @param {object} [renderOptions] Options forwarded to `renderDiff`.
 * @returns {string} Terminal bytes for the frame.
 * @throws Propagates errors from buffer creation, `paint`, or `renderDiff`; a paint/render error prevents the buffer swap.
 */
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

/**
 * Mark the terminal image as unknown so the next presentation repaints fully.
 * @param {ReturnType<typeof createScreen>} screen Mutable screen state.
 * @returns {void}
 */
export function screenInvalidate(screen) {
  screen.known = false;
}

/**
 * Release screen buffers and reset the state for a new session.
 * @param {ReturnType<typeof createScreen>} screen Mutable screen state.
 * @returns {void}
 */
export function screenRelease(screen) {
  screen.front = null;
  screen.back = null;
  screen.known = false;
}
