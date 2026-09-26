import { sgr } from "./cell.js";
import { CURSOR_SHOW, SYNC_START, SYNC_END } from "./term.js";

const RESET = "\x1b[0m";
const ERASE_DOWN = "\x1b[J";
const CLEAR = "\x1b[3J\x1b[2J\x1b[H";

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

/** Convert a Cell Buffer to relative-addressing-safe row strings. */
export function bufferRows(buffer) {
  return Array.from({ length: buffer.h }, (_, y) => rowBytes(buffer.row(y)));
}

/** Native-scrollback byte renderer. It never emits CUP or alt-screen codes. */
export function createInlineRenderer({ rows, sync = true }) {
  const height = () => Math.max(1, rows?.() || 24);
  const wrap = (bytes) => (bytes && sync ? `${SYNC_START}${bytes}${SYNC_END}` : bytes);
  let region = [];
  // Physical cursor location expressed relative to the live-region origin.
  // It is deliberately retained for an empty region: that origin is still the
  // terminal line where a later tail begins.
  let cursorRow = null;
  let cursorCol = 1;
  let viewportHeight = null;

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

  function cursorMove(cursor, length) {
    if (!cursor) return "";
    const row = Math.max(1, Math.min(length || 1, cursor.row));
    const col = Math.max(1, cursor.col);
    if (cursorRow === row && cursorCol === col) return "";
    return moveTo(row, col);
  }

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

    if (commit.length) out += commit.map((line) => `${line}\n`).join("");
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
    refresh: (frame) => {
      region = [];
      cursorRow = null;
      cursorCol = 1;
      viewportHeight = null;
      return CLEAR + paint(frame);
    },
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
    region: () => region.slice(),
  };
}
