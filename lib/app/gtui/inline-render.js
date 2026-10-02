import { sgr } from "./cell.js";
import { CURSOR_SHOW, SYNC_START, SYNC_END } from "./term.js";

const RESET = "\x1b[0m";
const ERASE_DOWN = "\x1b[J";
const CLEAR = "\x1b[3J\x1b[2J\x1b[H";

/**
 * Render cells as one terminal row, emitting SGR transitions only when styles change.
 * Null-text cells are omitted; a trailing reset is emitted when a style is active,
 * and trailing whitespace is trimmed. Calls `sgr` for each non-null-text cell.
 * @param {Iterable<{text: string|null}>} cells Cells in display order.
 * @returns {string} Row bytes with no trailing whitespace.
 */
function rowBytes(cells) {
  let out = "";
  let active = "";
  for (const cell of cells) {
    if (cell.text === null) continue;
    const next = sgr(cell);
    if (next !== active) {
      out += RESET + next;
      active = next;
    }
    out += cell.text;
  }
  return (active === "" ? out : out + RESET).trimEnd();
}

/**
 * Convert every row of a Cell Buffer to relative-addressing-safe terminal bytes.
 * @param {{h: number, row: (y: number) => Iterable<{text: string|null}>}} buffer
 *   Buffer whose height and row accessor define the rendered rows.
 * @returns {string[]} Rendered rows in top-to-bottom order.
 * @throws Propagates errors from the buffer accessor or cell/style rendering.
 */
export function bufferRows(buffer) {
  return Array.from({ length: buffer.h }, /** @param {undefined} _ Unused array slot.
   * @param {number} y Zero-based buffer row index.
   * @returns {string} Rendered row bytes.
   */ (_, y) => rowBytes(buffer.row(y)));
}

/**
 * Create a renderer that paints a live region using native terminal scrollback.
 * It never emits CUP or alternate-screen codes. Reading `rows` determines the
 * viewport height when painting; terminal output is returned, not written here.
 * @param {Object} options Renderer options.
 * @param {(() => number|null|undefined)|undefined} [options.rows] Callback for
 *   current terminal height; if absent or its result is falsey, height defaults to 24 (minimum 1).
 * @param {boolean} [options.sync=true] Wrap nonempty output in synchronized-update
 *   start/end controls.
 * @returns {{paint: Function, refresh: Function, leave: Function, region: Function}}
 *   Synchronous renderer operations; each returns terminal bytes or a row snapshot.
 * @throws Propagates errors from the height callback or invalid frame data.
 */
export function createInlineRenderer({ rows, sync = true }) {
  /** @returns {number} Current viewport height, clamped to at least one row. */
  const height = () => Math.max(1, rows?.() || 24);
  /** @param {string} bytes Terminal bytes to conditionally synchronize.
   * @returns {string} Wrapped bytes, or the original empty/unsynchronized bytes.
   */
  const wrap = (bytes) => (bytes && sync ? `${SYNC_START}${bytes}${SYNC_END}` : bytes);
  let region = [];
  // Physical cursor location expressed relative to the live-region origin.
  // It is deliberately retained for an empty region: that origin is still the
  // terminal line where a later tail begins.
  let cursorRow = null;
  let cursorCol = 1;
  let viewportHeight = null;

  /**
   * Move the physical cursor using relative vertical movement and CR-based columns.
   * Updates the tracked cursor location; emits no movement when only the row delta
   * is zero apart from the carriage return used to establish a column origin.
   * @param {number} row Target row relative to the live-region origin.
   * @param {number} [col=1] Target column, with column one represented by CR.
   * @returns {string} Relative terminal cursor-control bytes.
   */
  function moveTo(row, col = 1) {
    let out = "";
    if (cursorRow !== null) {
      const delta = row - cursorRow;
      if (delta < 0) out += `\x1b[${-delta}A`;
      if (delta > 0) out += `\x1b[${delta}B`;
    }
    // CR avoids absolute screen addressing; C is relative to column one.
    out += "\r";
    if (col > 1) out += `\x1b[${col - 1}C`;
    cursorRow = row;
    cursorCol = col;
    return out;
  }

  /**
   * Restore an application cursor, clamping its row to the rendered region.
   * @param {{row: number, col: number}|null} cursor Requested one-based caret, or null.
   * @param {number} length Number of visible rows available for clamping.
   * @returns {string} Cursor-control bytes, or an empty string if no move is needed.
   * @effects Updates tracked physical cursor state through `moveTo` when required.
   */
  function cursorMove(cursor, length) {
    if (!cursor) return "";
    const row = Math.max(1, Math.min(length || 1, cursor.row));
    const col = Math.max(1, cursor.col);
    if (cursorRow === row && cursorCol === col) return "";
    return moveTo(row, col);
  }

  /**
   * Paint a frame, appending committed lines to native history and updating the live tail.
   * Repaints changed rows, or the full region after a commit or viewport resize; then
   * optionally restores the requested caret. Updates the retained region, viewport,
   * and physical cursor state.
   * @param {Object} frame Frame description.
   * @param {string[]} [frame.commit=[]] Lines to commit above the live region; a newline is appended to each.
   * @param {string[]} frame.region New live-region rows in top-to-bottom order.
   * @param {{row: number, col: number}|null} [frame.cursor=null] Optional one-based
   *   caret position in the untrimmed region; omitted/hidden rows are not restored.
   * @returns {string} Synchronous terminal bytes, optionally synchronized by `sync`.
   * @throws Propagates errors while reading the height callback or frame properties.
   */
  function paint({ commit = [], region: nextRegion, cursor = null }) {
    const currentHeight = height();
    const omitted = Math.max(0, nextRegion.length - currentHeight);
    const next = nextRegion.slice(-currentHeight);
    let nextCursor = cursor ? { ...cursor, row: cursor.row - omitted } : null;
    if (nextCursor?.row < 1) nextCursor = null;

    const resized = viewportHeight !== null && viewportHeight !== currentHeight;
    const forceRepaint = commit.length > 0 || resized;
    let first = 0;
    if (!forceRepaint) {
      const limit = Math.min(region.length, next.length);
      while (first < limit && region[first] === next[first]) first++;
      if (first === region.length && first === next.length) {
        const out = cursorMove(nextCursor, next.length);
        viewportHeight = currentHeight;
        return wrap(out);
      }
    }

    let out = "";
    if (cursorRow !== null && (region.length > 0 || forceRepaint)) {
      // A commit inserts native history between the old and new tails, so the
      // old tail must be removed first. Resize is the other intentional full
      // repaint path; ordinary frames begin at their first changed row.
      out += moveTo(forceRepaint ? 1 : first + 1);
      out += ERASE_DOWN;
    }

    if (commit.length) out += commit.map(/** @param {string} line Committed line.
     * @returns {string} The line followed by a newline for native history.
     */ (line) => `${line}\n`).join("");
    if (next.length > (forceRepaint ? 0 : first)) {
      const suffix = next.slice(forceRepaint ? 0 : first);
      out += suffix.join("\n");
      cursorRow = next.length;
      // Row bytes have variable display width, so force a CR-based caret
      // restore instead of guessing the terminal's final column.
      cursorCol = 0;
    } else if (cursorRow === null) {
      cursorRow = 1;
      cursorCol = 1;
    }

    // A shorter suffix leaves the physical cursor at its old first changed
    // row; put it at the new tail even when no application caret is present.
    if (!nextCursor && cursorRow !== next.length) out += moveTo(Math.max(1, next.length));
    // A requested caret is restored from the newly printed suffix, never from
    // an absolute screen coordinate.
    out += cursorMove(nextCursor, next.length);
    region = next;
    viewportHeight = currentHeight;
    return wrap(out);
  }

  return {
    paint,
    /**
     * Clear the terminal and reset renderer tracking before painting a fresh frame.
     * @param {Object} frame Frame accepted by `paint`.
     * @returns {string} Clear-screen bytes followed by the painted frame bytes.
     * @effects Resets the retained region, cursor, and viewport height; then updates
     *   them as `paint` does. Errors from `paint` propagate after the reset.
     */
    refresh: (frame) => {
      region = [];
      cursorRow = null;
      cursorCol = 1;
      viewportHeight = null;
      return CLEAR + paint(frame);
    },
    /**
     * Leave the live region, placing the physical cursor after its tail when present.
     * @returns {string} Relative cursor/newline bytes followed by cursor-show control.
     * @effects Clears retained region and cursor/viewport tracking; does not wrap output
     *   in synchronized-update controls.
     */
    leave: () => {
      let out = "";
      if (region.length > 0 && cursorRow !== null) {
        const down = region.length - cursorRow;
        out += `${down > 0 ? `\x1b[${down}B` : ""}\r\n`;
      }
      region = [];
      cursorRow = null;
      cursorCol = 1;
      viewportHeight = null;
      return out + CURSOR_SHOW;
    },
    /** @returns {string[]} Shallow copy of the currently retained visible region. */
    region: () => region.slice(),
  };
}
