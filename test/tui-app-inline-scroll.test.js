// Inline transcript scrolling over a long, soft-wrapped assistant answer (the
// reported case: a table plus a wrapped last paragraph). Two contracts:
// 1. every scroll step moves the viewport by exactly one row — no jump at
//    the transition from the live tail (offset 0) into scrolled history;
// 2. native scrollback + the live screen hold every laid-out row exactly
//    once — nothing dropped at the scrollback/live boundary — both for a
//    finished answer and one that streamed in.
import { describe, expect, test } from "bun:test";
import { GTUI } from "../lib/app/gtui/gtui.js";
import { createTheme } from "../lib/app/gtui/theme.js";
import { measureView } from "../lib/app/gtui/layout.js";
import { createInlineTerminalRenderer, inlineHostInternals } from "../lib/app/gtui/terminal-inline-host.js";
import { createTranscriptProjector } from "../lib/app/tui/transcript.js";
import { TerminalScreen } from "./terminal-screen.js";

const ANSWER = `Here's a curated list of the **top 10 best hamburger spots in and around Soho, London**, based on reviews, awards, and food critic roundups (Time Out, Hardens, National Burger Awards, etc.):

| # | Restaurant | Address | Why it's notable |
|---|---|---|---|
| 1 | **Bleecker Burger – Soho** | 33 Old Compton St, W1D 5JU | Winner of National UK Burger of the Year (2020); NYC-style smashburgers, hugely hyped since opening in Soho in 2025 |
| 2 | **Patty & Bun – Kingly Street** | 26 Kingly St, W1B 5QD | A London burger institution; the "Ari Gold" cheeseburger is a cult favourite |
| 3 | **Burger & Beyond – Soho** | 10 Old Compton St, W1D 4TF | Known for the indulgent "Bougie Burger" — rich, char-heavy smash patties |
| 4 | **Honest Burgers – Meard Street** | 4a Meard St, W1F 0EF | British beef burgers with rosemary chips; consistently reliable quality |
| 5 | **MEATliquor W1** | 37-38 Margaret St, W1G 0JF | Dirty, indulgent US-diner-style burgers in a moody, late-night setting (short walk from Soho via Oxford Circus) |

**A few honourable mentions** just outside strict "Soho" boundaries but very close by:
- **Hanbaagaasuuteeki** (Victoria) — Time Out's #1 pick overall, Asian-inspired smashburgers.
- **The Plimsoll** (Finsbury Park) — Time Out's #2, a standout Dexter beef cheeseburger, though further afield.

**Tips:**
- Old Compton Street is now a genuine "burger row" — Bleecker and Burger & Beyond sit almost opposite each other.
- Prices generally range from about £9 (smash-style) up to £16–18 for the more "gourmet" builds.

Want me to save this as a note or research file for later reference (e.g., for trip planning), or dig deeper into any specific one (menu, hours, reservations)?
`;

const SIZES = [[40, 12], [60, 8], [80, 20], [100, 30], [120, 45]];
const theme = createTheme();
const plain = (rows) => rows.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd());
const blocks = (text, open = false) => [
  { type: "user", text: "top 10 burgers in soho", group: "message", section: "User", ordinal: 0 },
  { type: "text", text, open, group: "message", section: "Text", ordinal: 1 },
];
const root = (items, offset = 0) => GTUI.view.column({}, [
  GTUI.view.scroll({ id: "history", anchor: "end", offset, priority: 0 }, [GTUI.view.feed({ id: "feed", items })]),
  GTUI.view.text({ margin: 0, priority: 20 }, "BOTTOM"),
]);

function session(width, height) {
  const output = new TerminalScreen(width, height);
  const renderer = createInlineTerminalRenderer({ write: (bytes) => output.write(bytes), rows: () => height });
  const render = (node) => renderer.render(node, theme, { width, height });
  const screen = () => {
    const lines = output.text().split("\n");
    while (lines.length < height) lines.push("");
    return plain(lines.slice(0, lines.findIndex((line) => line.startsWith("BOTTOM"))));
  };
  const physical = () => {
    const lines = plain([...output.history, ...output.text().split("\n")]);
    return lines.slice(0, lines.findIndex((line) => line.startsWith("BOTTOM")));
  };
  return { render, screen, physical };
}

/** The whole feed laid out at the inline render width (one column short). */
function fullLayout(items, width) {
  const feed = GTUI.view.feed({ id: "all", items });
  const height = measureView(feed, { width: width - 1, height: 4096, theme }).height;
  return plain(inlineHostInternals.rowsFor(feed, width - 1, theme, undefined, height).rows);
}

const trimLeadingBlank = (rows) => { const out = rows.slice(); while (out[0] === "") out.shift(); return out; };

describe("inline transcript scrolling over a long soft-wrapped answer", () => {
  for (const [width, height] of SIZES) {
    test(`${width}x${height}: each scroll step shifts the viewport by one row`, () => {
      const items = createTranscriptProjector().project(blocks(ANSWER));
      const tui = session(width, height);
      tui.render(root(items, 0));
      let previous = tui.screen();
      for (let offset = 1; offset < 40; offset++) {
        tui.render(root(items, offset));
        const current = tui.screen();
        if (current.join("\n") === previous.join("\n")) break; // clamped at the top
        expect(current.length).toBe(previous.length);
        expect(current.slice(1)).toEqual(previous.slice(0, -1));
        previous = current;
      }
    });

    test(`${width}x${height}: scrollback + screen hold every row once (finished and streamed)`, () => {
      const finished = createTranscriptProjector().project(blocks(ANSWER));
      const expected = trimLeadingBlank(fullLayout(finished, width));
      const done = session(width, height);
      done.render(root(finished));
      expect(trimLeadingBlank(done.physical())).toEqual(expected);

      const projector = createTranscriptProjector();
      const streamed = session(width, height);
      for (let at = 0; at < ANSWER.length; at += 97) streamed.render(root(projector.project(blocks(ANSWER.slice(0, at), true))));
      streamed.render(root(projector.project(blocks(ANSWER))));
      expect(trimLeadingBlank(streamed.physical())).toEqual(expected);
    });
  }
});
