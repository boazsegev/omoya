import { expect, test } from "bun:test";
import { questionView, QUESTION_INPUT_ID, QUESTION_MENU_ID } from "../lib/tui-app/questionnaire-view.js";

const question = {
  header: "Choice", question: "Pick", options: [
    { label: "A", description: "Details", preview: { title: "Example", type: "text", content: "Body" } },
  ],
};

function children(hasNext = false) {
  return questionView(question, "", "menu", [], null, undefined, null, "A", false, hasNext).children[0].children;
}

test("question action is Next only with a followup and Submit when final", () => {
  const menu = (hasNext) => children(hasNext).find((node) => node.id === QUESTION_MENU_ID);
  expect(menu(true).items.find((item) => item.value?.type === "question.submit").label).toBe("Next");
  expect(menu(false).items.find((item) => item.value?.type === "question.submit").label).toBe("Submit");
});

test("question preview separates shortcuts, title, and content", () => {
  const nodes = children();
  const inputAt = nodes.findIndex((node) => node.id === QUESTION_INPUT_ID);
  const text = (node) => typeof node.content === "string" ? node.content : node.content?.map?.((span) => span.text).join("") ?? "";
  const shortcutsAt = nodes.findIndex((node) => text(node).includes("Enter →"));
  const titleAt = nodes.findIndex((node) => text(node) === "Example");
  const bodyAt = nodes.findIndex((node) => text(node) === "Body");
  expect(shortcutsAt).toBeGreaterThan(inputAt);
  expect(titleAt).toBeGreaterThan(shortcutsAt + 1);
  expect(bodyAt).toBeGreaterThan(titleAt + 1);
});
