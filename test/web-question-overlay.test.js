import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../lib/app/web/public/style.css", import.meta.url), "utf8");
const source = js.slice(js.indexOf("function renderQuestion()"), js.indexOf("function closeQuestion()"));
const document = { activeElement: null };

function element(tag, className = "", textContent = "") {
  const listeners = new Map();
  const node = {
    tag, className, textContent, children: [], dataset: {}, attributes: {}, value: "", open: false,
    classList: {
      contains: (name) => node.className.split(" ").includes(name),
      toggle: (name, active) => { node.className = [...new Set(node.className.split(" ").filter((part) => part !== name).concat(active ? [name] : []))].join(" "); },
      remove: (name) => node.classList.toggle(name, false),
    },
    append(...items) { this.children.push(...items); },
    prepend(...items) { this.children.unshift(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = value; },
    matches(selector) { return selector.split(", ").some((part) => part.startsWith(".") ? this.classList.contains(part.slice(1)) : this.tag === part); },
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    addEventListener(type, callback) { const callbacks = listeners.get(type) ?? []; callbacks.push(callback); listeners.set(type, callbacks); },
    fire(type, props = {}) { for (const callback of listeners.get(type) ?? []) callback({ target: node, key: "", preventDefault() {}, ...props }); },
    focus() { document.activeElement = this; this.fire("focus"); },
    click() { this.focus(); this.fire("click"); },
    close() { this.fire("close"); },
  };
  return node;
}

function harness(questions) {
  const dialog = element("dialog");
  const body = element("div", "panel-body");
  const head = element("header"); head.append(element("h2"));
  dialog.append(head, body);
  const sent = [];
  document.activeElement = null;
  const openQuestion = { requestId: "q1", questions };
  const render = new Function("scope", `with (scope) { ${source}; return renderQuestion; }`)({
    openQuestion, openDialog: () => ({ dialog, body, head }), el: element, markdownNode: element,
    button: (className, text, onClick) => { const node = element("button", className, text); if (onClick) node.addEventListener("click", onClick); return node; },
    document, send: (value) => sent.push(value),
  });
  render();
  return { dialog, body, document, sent, options: body.querySelectorAll(".question-option"), previews: body.querySelectorAll(".question-preview-pane") };
}

const question = { question: "Choose", options: [{ label: "A", preview: "First" }, { label: "B", preview: "Second" }] };

// Simulate keydown bubbling and the browser's default Enter/Space activation
// for a focused button (unless a handler prevented the default action).
function press(view, key, target = view.document.activeElement) {
  let prevented = false;
  const event = { key, target, preventDefault() { prevented = true; } };
  target.fire("keydown", event);
  if (target !== view.dialog) view.dialog.fire("keydown", event);
  if (!prevented && (key === "Enter" || key === " ") && target.tag === "button" && !target.disabled) target.click();
  return prevented;
}

test("preview stays with selection while focus moves, and clears when a custom answer replaces it", () => {
  const view = harness([question]);
  const [a, b] = view.options;
  a.click();
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("First");
  b.focus();
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("First");
  b.click();
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("Second");
  const other = view.body.querySelector(".question-other");
  other.value = "Something else"; other.fire("input");
  expect(view.previews[0].querySelector(".question-preview")).toBeNull();
});

test("number keys select the labelled answer, arrows move focus without changing preview", () => {
  const view = harness([question]);
  press(view, "2");
  expect(view.options[1].classList.contains("selected")).toBe(true);
  expect(view.document.activeElement).toBe(view.body.querySelector(".question-submit"));
  press(view, "ArrowUp");
  expect(view.document.activeElement).toBe(view.options[1]);
  press(view, "ArrowUp");
  expect(view.document.activeElement).toBe(view.options[0]);
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("Second");
});

test("multi-select toggles the last selected preview and keeps the remaining selection", () => {
  const view = harness([{ ...question, multiSelect: true }]);
  view.options[0].click();
  view.options[1].click();
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("Second");
  view.options[1].click();
  expect(view.options[0].classList.contains("selected")).toBe(true);
  expect(view.previews[0].querySelector(".question-preview")?.textContent).toBe("First");
});

test("number keys span questions and do not intercept typing in a custom answer", () => {
  const view = harness([question, { question: "Second", options: [{ label: "C", preview: "Third" }] }]);
  view.dialog.fire("keydown", { key: "3", target: view.options[0] });
  expect(view.options[2].classList.contains("selected")).toBe(true);
  expect(view.previews[1].querySelector(".question-preview")?.textContent).toBe("Third");
  const other = view.body.querySelector(".question-other");
  view.dialog.fire("keydown", { key: "1", target: other });
  expect(view.options[0].classList.contains("selected")).toBe(false);
});

test("Enter selects the focused answer instead of submitting, then Enter on Submit sends it", () => {
  const view = harness([question]);
  view.options[0].click();
  view.options[1].focus();
  press(view, "Enter");
  expect(view.options[1].classList.contains("selected")).toBe(true);
  expect(view.sent).toEqual([]);
  const submit = view.body.querySelector(".question-submit");
  submit.focus();
  press(view, "Enter");
  expect(view.sent).toEqual([{ type: "question.answer", requestId: "q1", answers: [{ labels: ["B"] }] }]);
});

test("number then Enter selects and submits when every question is answered", () => {
  const view = harness([question]);
  const submit = view.body.querySelector(".question-submit");
  press(view, "2");
  expect(view.options[1].classList.contains("selected")).toBe(true);
  expect(view.document.activeElement).toBe(submit);
  expect(view.sent).toEqual([]);
  press(view, "Enter");
  expect(view.sent[0]?.answers).toEqual([{ labels: ["B"] }]);
});

test("number selection with unanswered questions never submits prematurely", () => {
  const view = harness([question, { question: "More", options: [{ label: "C" }] }]);
  const submit = view.body.querySelector(".question-submit");
  press(view, "1");
  expect(submit.disabled).toBe(true);
  expect(view.document.activeElement).not.toBe(submit);
  press(view, "Enter");
  expect(view.sent).toEqual([]);
  press(view, "3");
  expect(view.document.activeElement).toBe(submit);
  press(view, "Enter");
  expect(view.sent[0]?.answers).toEqual([{ labels: ["A"] }, { labels: ["C"] }]);
});

test("Enter in custom answer does not submit unless Submit has focus", () => {
  const view = harness([question]);
  const other = view.body.querySelector(".question-other");
  other.value = "custom"; other.fire("input"); other.focus();
  press(view, "Enter");
  expect(view.sent).toEqual([]);
});

test("a question dialog and its preview have stable viewport-bounded geometry", () => {
  expect(css).toMatch(/dialog\.question-dialog\s*\{[^}]*height:\s*min\(/);
  expect(css).toMatch(/\.question-preview-pane\s*\{[^}]*height:\s*12rem;[^}]*overflow:\s*auto/);
});
