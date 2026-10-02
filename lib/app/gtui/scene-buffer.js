import { createBuffer } from "./buffer.js";

/**
 * Check whether any canvas cell whose `text` is not `null` has a themed animation.
 *
 * @param {object} scene Laid-out scene with `canvas.cells` rows of cells.
 * @param {object} theme Theme whose optional `animation(role)` predicate identifies animated roles.
 * @returns {boolean} `true` if at least one non-empty cell's role is animated; otherwise `false`.
 * @throws {TypeError} If the scene/canvas structure is invalid; errors from `theme.animation` are propagated.
 */
export function sceneHasAnimations(scene, theme) {
  return scene.canvas.cells.some((row) => row.some((cell) => cell?.text !== null && theme.animation?.(cell?.role)));
}

/**
 * Paint scene cells with resolved, stable theme styles and place its caret.
 * Reuses and resets `target` when its dimensions match the canvas; otherwise creates a buffer.
 *
 * @param {object} scene Laid-out scene with canvas dimensions, cells, and an optional caret.
 * @param {object} theme Theme providing `resolve(role)` styles.
 * @param {object|null} [target=null] Optional buffer to reuse when its width and height match the canvas.
 * @returns {object} The populated buffer, either the reused target or a newly created buffer.
 * @throws {Error} Errors from buffer creation, reset/writes, or theme style resolution are propagated.
 */
export function sceneBaseBuffer(scene, theme, target = null) {
  const { canvas } = scene;
  const reuse = target && target.w === canvas.width && target.h === canvas.height;
  const buffer = reuse ? target : createBuffer(canvas.width, canvas.height);
  if (reuse) buffer.reset();
  for (let y = 0; y < canvas.height; y++) {
    const row = canvas.cells[y];
    let x = 0;
    while (x < canvas.width) {
      const source = row[x];
      if (!source || source.text === null) { x++; continue; }
      const role = source.role ?? "text";
      let end = x + 1;
      while (end < canvas.width && row[end] && row[end].text !== null && (row[end].role ?? "text") === role) end++;
      const style = theme.resolve(role);
      for (let at = x; at < end; at++) {
        const cell = row[at];
        // Layout already measured every canvas glyph (cellWidth).
        buffer.set(at, y, cell.text, { ...style, url: cell.link ?? null }, cell.cellWidth);
      }
      x = end;
    }
  }
  if (canvas.caret && canvas.caret.row >= 0 && canvas.caret.row < canvas.height && canvas.caret.column < canvas.width) {
    buffer.setCursor(canvas.caret.column, canvas.caret.row);
  }
  return buffer;
}

/**
 * Paint a scene into terminal cells, applying animated or resolved styles per contiguous role run.
 * Starts with `sceneBaseBuffer` and updates each populated cell's foreground, background, and attributes.
 *
 * @param {object} scene Laid-out scene with canvas dimensions and cells.
 * @param {object} theme Theme providing `resolve(role)` and optionally `animated(role, frame)`; animation frames receive `{time, index, count}` for each cell in a contiguous role run.
 * @param {number} [time=Date.now()] Host-clock timestamp passed to animation callbacks as `frame.time`.
 * @returns {object} The populated terminal-cell buffer.
 * @throws {Error} Errors from base-buffer creation, theme styling, or buffer operations are propagated.
 */
export function sceneBuffer(scene, theme, time = Date.now()) {
  const buffer = sceneBaseBuffer(scene, theme);
  const { canvas } = scene;
  for (let y = 0; y < canvas.height; y++) {
    const row = canvas.cells[y];
    let x = 0;
    while (x < canvas.width) {
      const source = row[x];
      if (!source || source.text === null) { x++; continue; }
      const role = source.role ?? "text";
      let end = x + 1;
      while (end < canvas.width && row[end] && row[end].text !== null && (row[end].role ?? "text") === role) end++;
      for (let at = x; at < end; at++) {
        const style = theme.animated ? theme.animated(role, { time, index: at - x, count: end - x }) : theme.resolve(role);
        const cell = buffer.cells[y * buffer.w + at];
        cell.fg = style.fg; cell.bg = style.bg; cell.attrs = style.attrs;
      }
      x = end;
    }
  }
  return buffer;
}
