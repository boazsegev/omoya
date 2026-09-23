import { expect, test } from "bun:test";
import { initialInput, applyChange, cycleCompletions, acceptCompletion } from "../lib/tui-app/input-controller.js";

const sources = { commands: ["/alpha", "/alpine", "/alps"] };

test("cycling places candidates in input and preserves the candidate set", () => {
  let input = applyChange(initialInput(), { value: "/al", caret: 3 }, sources);
  const choices = input.completions;
  input = cycleCompletions(input, 1);
  expect(input.value).toBe(choices[input.completionIndex]);
  expect(input.completions).toEqual(choices);
  input = cycleCompletions(input, 1);
  expect(input.value).toBe(choices[input.completionIndex]);
  input = cycleCompletions(input, -1);
  expect(input.value).toBe(choices[input.completionIndex]);
  expect(acceptCompletion(input).value).toBe(input.value);
});

test("cycling replacement ranges preserve text after the caret", () => {
  const input = { ...initialInput(), value: "before fi after", caret: 9, completions: ["file", "folder"], completionStart: 7, completionEnd: 9, completionIndex: 0 };
  const first = cycleCompletions(input, 1);
  const second = cycleCompletions(first, -1);
  expect(first.value).toBe("before folder after");
  expect(second.value).toBe("before file after");
  expect(second.caret).toBe(11);
});
