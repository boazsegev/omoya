import { createBuffer } from "./buffer.js";

/** True when the laid-out scene contains a themed role that needs host-clock frames. */
export function sceneHasAnimations(scene, theme) {
  return scene.canvas.cells.some((row) => row.some((cell) => cell?.text !== null && theme.animation?.(cell?.role)));
}

/** Paint scene geometry and stable styles into a fresh buffer. */
export function sceneBaseBuffer(scene, theme) {
  const { canvas } = scene;
  const buffer = createBuffer(canvas.width, canvas.height);
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
        const cell = row[at];
        const style = theme.resolve(role);
        buffer.set(at, y, cell.text, { ...style, url: cell.link ?? null });
      }
      x = end;
    }
  }
  if (canvas.caret && canvas.caret.row >= 0 && canvas.caret.row < canvas.height && canvas.caret.column < canvas.width) {
    buffer.setCursor(canvas.caret.column, canvas.caret.row);
  }
  return buffer;
}

/** Paint one semantic scene into terminal cells, applying animations per contiguous role run. */
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
