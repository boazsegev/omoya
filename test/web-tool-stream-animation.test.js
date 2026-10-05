import { expect, test } from "bun:test";
import { patchStreamingCard } from "../lib/app/web/public/app/logic/transcript-rows.js";

function element(tag, className = "", textContent = "") {
  const node = {
    tag, className, textContent, childNodes: [], attributes: {},
    get firstElementChild() { return this.childNodes[0] ?? null; },
    matches(selector) { return selector === "summary" ? this.tag === "summary" : this.className.split(" ").includes(selector.slice(1)); },
    querySelector(selector) {
      for (const child of this.childNodes) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    append(...items) { this.childNodes.push(...items); },
    remove() { this.removals = (this.removals ?? 0) + 1; },
    insertBefore(item, next) {
      const previous = this.childNodes.indexOf(item);
      if (previous >= 0) this.childNodes.splice(previous, 1);
      const index = next ? this.childNodes.indexOf(next) : -1;
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, item);
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
  };
  return node;
}

function card(kind, output = "first", args = "", state = "running") {
  const bubble = element("details", `msg msg-${kind}${kind === "tool" ? ` tool-${state}` : ""}`);
  const summary = element("summary");
  const head = element("span", "card-head");
  const icon = element("span", kind === "tool" ? "tool-state" : "block-kind", state);
  head.append(icon, element("span", "tool-name", "bash"));
  if (args) head.append(element("span", "tool-args-summary", args));
  if (kind === "thinking") head.append(element("span", "shimmer-dots"));
  summary.append(head, element("span", "preview", output));
  bubble.append(summary, element("div", "body", output));
  return bubble;
}

for (const kind of ["tool", "thinking"]) {
  test(`${kind} stream updates content without remounting its animated indicator`, () => {
    const bubble = card(kind);
    const row = { firstElementChild: bubble };
    const icon = bubble.querySelector(kind === "tool" ? ".tool-state" : ".shimmer-dots");
    patchStreamingCard(row, card(kind, "first\nsecond", "streaming arguments"));
    expect(row.firstElementChild).toBe(bubble);
    expect(bubble.querySelector(kind === "tool" ? ".tool-state" : ".shimmer-dots")).toBe(icon);
    expect(icon.removals ?? 0).toBe(0);
    expect(bubble.querySelector(".preview").textContent).toBe("first\nsecond");
    patchStreamingCard(row, card(kind, "final", ""));
    expect(icon.removals ?? 0).toBe(0);
    expect(row.firstElementChild).toBe(bubble);
  });
}

test("tool completion swaps the running card for a settled state", () => {
  const running = card("tool");
  const complete = card("tool", "done", "", "ok");
  expect(running.className).toContain("tool-running");
  expect(complete.className).toContain("tool-ok");
  expect(complete).not.toBe(running);
});
