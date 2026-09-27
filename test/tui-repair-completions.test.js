import { expect, test } from "bun:test";
import { createCompletionSources } from "../lib/app/tui/completion-sources.js";
import { Context } from "../lib/context.js";
import { initialInput, applyChange } from "../lib/app/tui/input-controller.js";

test("ordinary typing never enumerates saved sessions or prompt files", () => {
  let sessionReads = 0;
  let promptReads = 0;
  const env = { endpointNames: () => [], toolNames: () => [], prompts: () => { promptReads++; return new Map(); } };
  const agent = { context: new Context({ messages: [] }), listSessions: () => { sessionReads++; return []; } };
  const sources = createCompletionSources(agent, env);
  const input = applyChange(initialInput(), { value: "hello", caret: 5 }, sources);
  expect(input.value).toBe("hello");
  expect(sessionReads).toBe(0);
  expect(promptReads).toBe(0);
});
