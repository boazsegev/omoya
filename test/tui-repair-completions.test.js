import { expect, test } from "bun:test";
import { createCompletionSources } from "../lib/tui-app/completion-sources.js";
import { initialInput, applyChange } from "../lib/tui-app/input-controller.js";

test("ordinary typing never enumerates saved sessions or prompt files", () => {
  let sessionReads = 0;
  let promptReads = 0;
  const env = { endpointNames: () => [], toolNames: () => [], promptNames: () => { promptReads++; return []; } };
  const agent = { context: [], listSessions: () => { sessionReads++; return []; } };
  const sources = createCompletionSources(agent, env);
  const input = applyChange(initialInput(), { value: "hello", caret: 5 }, sources);
  expect(input.value).toBe("hello");
  expect(sessionReads).toBe(0);
  expect(promptReads).toBe(0);
});
