import { EventEmitter } from "node:events";

/** Small terminal-state oracle for viewport tests (CSI/OSC + wrap + scroll). */
export class TerminalScreen extends EventEmitter {
  constructor(columns = 60, rows = 16) {
    super();
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
        if (this.x >= this.columns) { this.x = 0; this.lineFeed(); }
        this.grid[this.y][this.x++] = char;
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
