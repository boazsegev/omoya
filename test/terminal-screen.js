import { EventEmitter } from "node:events";

/** Small terminal-state oracle for viewport tests (CSI/OSC + wrap + scroll). */
export class TerminalScreen extends EventEmitter {
  /** `wide(char)` (optional) marks glyphs the emulated terminal draws two
   *  columns wide, independent of the renderer's own width table. */
  constructor(columns = 60, rows = 16, { wide = () => false } = {}) {
    super();
    this.wide = wide;
    this.columns = columns;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(columns).fill(" "));
    this.history = [];
    this.chunks = [];
    this.x = 0;
    this.y = 0;
    this.pending = "";
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    this.pending += String(chunk);
    while (this.pending.length) {
      if (this.pending.startsWith("\x1b]")) {
        const match = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(this.pending);
        if (!match) return;
        this.pending = this.pending.slice(match[0].length);
        continue;
      }
      if (this.pending.startsWith("\x1b[")) {
        const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(this.pending);
        if (!match) return;
        this.csi(match[1], match[3]);
        this.pending = this.pending.slice(match[0].length);
        continue;
      }
      const char = String.fromCodePoint(this.pending.codePointAt(0));
      this.pending = this.pending.slice(char.length);
      if (char === "\r") this.x = 0;
      else if (char === "\n") { this.x = 0; this.lineFeed(); }
      else if (char >= " " && char !== "\x7f") {
        const span = this.wide(char) ? 2 : 1;
        if (this.x + span > this.columns) { this.x = 0; this.lineFeed(); }
        this.grid[this.y][this.x++] = char;
        if (span === 2) this.grid[this.y][this.x++] = "";
      }
    }
  }
  lineFeed() {
    if (++this.y < this.rows) return;
    this.history.push(this.grid.shift().join("").trimEnd());
    this.grid.push(Array(this.columns).fill(" "));
    this.y = this.rows - 1;
  }
  csi(parameters, final) {
    if (parameters.startsWith("?")) return;
    const values = parameters.split(";").map(Number);
    const count = values[0] || 1;
    if (final === "A") this.y = Math.max(0, this.y - count);
    if (final === "B") this.y = Math.min(this.rows - 1, this.y + count);
    if (final === "C") this.x = Math.min(this.columns - 1, this.x + count);
    if (final === "D") this.x = Math.max(0, this.x - count);
    if (final === "G") this.x = Math.min(this.columns - 1, count - 1);
    if (final === "H" || final === "f") { this.y = Math.min(this.rows - 1, count - 1); this.x = Math.min(this.columns - 1, (values[1] || 1) - 1); }
    if (final === "J") {
      const mode = values[0] || 0;
      if (mode === 2 || mode === 3) this.grid = Array.from({ length: this.rows }, () => Array(this.columns).fill(" "));
      else { this.grid[this.y].fill(" ", this.x); for (let y = this.y + 1; y < this.rows; y++) this.grid[y].fill(" "); }
      if (mode === 3) this.history = [];
    }
    if (final === "K") this.grid[this.y].fill(" ", values[0] === 2 ? 0 : this.x);
  }
  /** Resize like a terminal without reflow: crop/pad rows and columns,
   *  keep the old content, emit "resize" for a listening host. */
  resize(columns, rows) {
    const grid = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => this.grid[y]?.[x] ?? " "));
    this.grid = grid;
    this.columns = columns;
    this.rows = rows;
    this.x = Math.min(this.x, columns - 1);
    this.y = Math.min(this.y, rows - 1);
    this.emit("resize");
  }
  lines() { return this.grid.map((line) => line.join("").trimEnd()); }
  text() { return this.lines().join("\n"); }
  bytes() { return this.chunks.join(""); }
}

export class TerminalInput extends EventEmitter {
  isTTY = true;
  raw = [];
  setRawMode(value) { this.raw.push(value); }
  resume() {}
  pause() {}
}
