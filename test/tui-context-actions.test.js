import { describe, expect, test } from "bun:test";
import Context, { ContentType, MessageType } from "../lib/context.js";
import {
  applyContextMutation, applyContextSave, contextActionMenu, contextEditForm,
} from "../lib/app/tui/context-actions.js";
import { contextBlocks } from "../lib/app/tui/context-blocks.js";
import { formErrors, updateForm, FORM_INPUT_PREFIX } from "../lib/app/tui/form.js";

const text = (value) => ({ type: ContentType.Text, text: value });
const user = (value) => ({ type: MessageType.User, content: [text(value)] });
const assistant = (content) => ({ type: MessageType.Assistant, content });
const viewer = () => ({ type: "viewer", index: 0, offset: 0, filters: [], search: "" });
const rows = (menu) => menu.stack.at(-1).items;
const row = (menu, label) => rows(menu).find((item) => item.label === label || item.label.startsWith(`${label} — `));

function agentCreate(messages = [user("original")]) {
  return { context: new Context({ id: false, save: false, messages }), busy: false, closed: false, closeMarked: false };
}

function blockCreate(options = {}) {
  return { type: "user", message: 0, text: "original", open: false, ...options };
}

describe("context viewer Actions menus", () => {
  test("offers copy, safe editing, exclusive fork boundary, guarded mutations and back without effects", () => {
    const agent = agentCreate([user("first"), user("second")]);
    const block = blockCreate({ message: 1, text: "second" });
    const back = viewer();
    const before = structuredClone(agent.context.messages());
    const menu = contextActionMenu(agent, block, back);
    expect(menu.type).toBe("menu");
    expect(menu.stack[0].title).toBe("Actions");
    expect(rows(menu).map((item) => item.label)).toEqual(["Copy", "Edit text", "Fork through here", "Roll back", "Delete message", "← back"]);
    expect(row(menu, "Copy").value).toEqual({ type: "access.context.copy", agent, block, viewer: back });
    expect(row(menu, "Edit text").value).toEqual({ type: "access.context.edit", agent, block, viewer: back });
    expect(row(menu, "Edit text").value.block).toBe(block);
    expect(row(menu, "Fork through here").value).toEqual({ type: "access.context.fork", agent, through: 2, viewer: back });
    expect(row(menu, "Roll back").value).toEqual({ type: "access.context.rollback", agent, index: 1, expectedMessage: agent.context.at(1), viewer: back });
    expect(row(menu, "Delete message").value).toEqual({ type: "access.context.delete", agent, index: 1, expectedMessage: agent.context.at(1), viewer: back });
    expect(row(menu, "← back").value).toEqual({ type: "access.context.back", viewer: back });
    expect(agent.context.messages()).toEqual(before);
    expect(back.index).toBe(0);
  });

  test("assistant text and thinking edit only with an actual matching content index", () => {
    const agent = agentCreate([assistant([{ type: ContentType.Thinking, text: "plan" }, text("reply")])]);
    for (const [type, contentIndex] of [["thinking", 0], ["text", 1]]) {
      const menu = contextActionMenu(agent, blockCreate({ type, contentIndex }), viewer());
      expect(row(menu, "Edit text").kind).toBe("action");
      expect(row(menu, "Edit text").value.block.contentIndex).toBe(contentIndex);
    }
    for (const block of [blockCreate({ type: "text" }), blockCreate({ type: "text", contentIndex: 0 }), blockCreate({ type: "text", contentIndex: 25 })]) {
      const menu = contextActionMenu(agent, block, viewer());
      expect(row(menu, "Edit text").kind).toBe("info");
      expect(row(menu, "Edit text").value).toBeUndefined();
      expect(row(menu, "Delete message").kind).toBe("action");
    }
  });

  test("a single user/system text block can edit without flattening attachments", () => {
    for (const [type, projectedType] of [[MessageType.User, "user"], [MessageType.System, "system"]]) {
      const agent = agentCreate([{ type, content: [{ type: ContentType.Binary, mimetype: "application/pdf", filename: "note.pdf", content: "AA==" }, text("message")] }]);
      const menu = contextActionMenu(agent, blockCreate({ type: projectedType, text: "[binary]\n\nmessage" }), viewer());
      expect(row(menu, "Edit text").kind).toBe("action");
      const selected = row(menu, "Edit text").value.block;
      expect(contextEditForm(agent, selected.sourceMessage ?? selected.message, selected.contentIndex).action.blockIndex).toBe(1);
    }
  });

  test("single user/system Thinking content uses the same persisted block editing contract", () => {
    for (const type of [MessageType.User, MessageType.System]) {
      const agent = agentCreate([{ type, content: [{ type: ContentType.Thinking, text: "plan" }] }]);
      const block = contextBlocks(agent.context.messages())[0];
      expect(block.contentIndex).toBe(0);
      const action = row(contextActionMenu(agent, block, viewer()), "Edit text").value;
      const form = contextEditForm(action.agent, action.block.sourceMessage ?? action.block.message, action.block.contentIndex, action.viewer);
      expect(form.values.text).toBe("plan");
      applyContextSave(form.action, { text: "new plan" });
      expect(agent.context.at(0).content).toEqual([{ type: ContentType.Thinking, text: "new plan" }]);
    }
  });

  test("an aggregate multi-text message refuses editing unless a specific content block is supplied", () => {
    const agent = agentCreate([{ type: MessageType.User, content: [text("first"), text("second")] }]);
    const aggregate = blockCreate({ text: "first\n\nsecond" });
    const menu = contextActionMenu(agent, aggregate, viewer());
    expect(row(menu, "Edit text").kind).toBe("info");
    expect(row(menu, "Edit text").label).toContain("specific content block");
    expect(row(contextActionMenu(agent, { ...aggregate, contentIndex: 1 }, viewer()), "Edit text").kind).toBe("action");
    expect(agent.context.at(0).content).toEqual([text("first"), text("second")]);
  });

  test("virtual, open, unavailable and out-of-range blocks keep copy but never expose mutation actions", () => {
    const agent = agentCreate();
    for (const block of [blockCreate({ virtual: true }), blockCreate({ open: true }), blockCreate({ message: -1 }), blockCreate({ message: 1 }), undefined]) {
      const menu = contextActionMenu(agent, block, viewer());
      expect(row(menu, "Copy").kind).toBe("action");
      for (const label of ["Edit text", "Fork through here", "Roll back", "Delete message"]) {
        const item = row(menu, label);
        expect(item.kind).toBe("info");
        expect(item.note.length).toBeGreaterThan(0);
        expect(item.value).toBeUndefined();
      }
      expect(row(menu, "← back").kind).toBe("action");
    }
  });

  test("busy and closing Agents produce reasons rather than executable changes", () => {
    for (const state of [{ busy: true }, { closed: true }, { closeMarked: true }, { env: { closed: true } }]) {
      const agent = Object.assign(agentCreate(), state);
      const menu = contextActionMenu(agent, blockCreate(), viewer());
      expect(row(menu, "Copy").kind).toBe("action");
      for (const label of ["Edit text", "Fork through here", "Roll back", "Delete message"]) {
        expect(row(menu, label).kind).toBe("info");
        expect(row(menu, label).label).toMatch(/busy|closed|closing/);
      }
    }
  });

  test("tool result projection cannot accidentally target its call owner or a viewer sourceIndex", () => {
    const agent = agentCreate([
      assistant([{ type: ContentType.ToolCall, name: "lookup", callId: "call", arguments: {} }]),
      { type: MessageType.ToolResult, callId: "call", name: "lookup", content: [text("result")], display: [text("display")] },
    ]);
    const projected = contextBlocks(agent.context.messages());
    const result = projected.find((block) => block.type === "toolresult");
    const display = projected.find((block) => block.type === "display");
    expect(result.message).toBe(0);
    for (const block of [result, display]) {
      const { sourceMessage, ...legacyBlock } = block;
      expect(sourceMessage).toBe(1);
      const menu = contextActionMenu(agent, { ...legacyBlock, sourceIndex: 1 }, viewer());
      expect(row(menu, "Copy").kind).toBe("action");
      for (const label of ["Edit text", "Fork through here", "Roll back", "Delete message"]) expect(row(menu, label).kind).toBe("info");
    }
    expect(agent.context.length).toBe(2);
  });

  test("current tool-result and tool-display projection metadata targets the actual persisted result", () => {
    const agent = agentCreate([
      assistant([{ type: ContentType.ToolCall, name: "lookup", callId: "call", arguments: {} }]),
      { type: MessageType.ToolResult, callId: "call", name: "lookup", content: [text("result")], display: [text("display")] },
    ]);
    const blocks = contextBlocks(agent.context.messages()).filter((block) => ["toolresult", "display"].includes(block.type));
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block.message).toBe(0);
      expect(block.sourceMessage).toBe(1);
      const menu = contextActionMenu(agent, block, viewer());
      expect(row(menu, "Edit text").kind).toBe("info");
      expect(row(menu, "Fork through here").value.through).toBe(2);
      expect(row(menu, "Roll back").value.index).toBe(1);
      const deletion = row(menu, "Delete message").value;
      expect(deletion.expectedMessage).toBe(agent.context.at(1));
    }
    const deletion = row(contextActionMenu(agent, blocks[0], viewer()), "Delete message").value;
    const callOwner = agent.context.at(0);
    applyContextMutation(deletion);
    expect(agent.context.length).toBe(1);
    expect(agent.context.at(0)).toBe(callOwner);
  });

  test("explicit tool-result source metadata selects its actual message for confirmed message actions", () => {
    const agent = agentCreate([
      assistant([{ type: ContentType.ToolCall, name: "lookup", callId: "call", arguments: {} }]),
      { type: MessageType.ToolResult, callId: "call", name: "lookup", content: [text("result")] },
    ]);
    for (const metadata of [{ resultMessage: 1 }, { sourceMessageIndex: 1 }, { sourceMessage: 1 }]) {
      const block = blockCreate({ type: "toolresult", message: 0, sourceIndex: 9, ...metadata });
      const menu = contextActionMenu(agent, block, viewer());
      expect(row(menu, "Edit text").kind).toBe("info");
      expect(row(menu, "Fork through here").value.through).toBe(2);
      expect(row(menu, "Delete message").value.index).toBe(1);
      expect(row(menu, "Delete message").value.expectedMessage).toBe(agent.context.at(1));
      expect(row(menu, "Roll back").value.index).toBe(1);
    }
    const wrong = contextActionMenu(agent, blockCreate({ type: "toolresult", resultMessage: 0 }), viewer());
    expect(row(wrong, "Delete message").kind).toBe("info");
  });

  test("display, draft, tool calls and errors never become text editors", () => {
    const agent = agentCreate([assistant([text("real text")])]);
    for (const type of ["display", "draft", "toolcall", "error"]) {
      const menu = contextActionMenu(agent, blockCreate({ type, contentIndex: 0, sourceMessageIndex: 0 }), viewer());
      expect(row(menu, "Edit text").kind).toBe("info");
    }
  });
});

describe("non-destructive context editor", () => {
  test("defaults to the last message and first actual Text/Thinking content, never the viewer's text", () => {
    const agent = agentCreate([user("earlier"), assistant([{ type: ContentType.ToolCall, callId: "call", name: "lookup", arguments: {} }, { type: ContentType.Thinking, text: "actual\nplan", signature: "retained" }, text("reply")])]);
    const original = agent.context.at(1);
    const back = viewer();
    const form = contextEditForm(agent, undefined, undefined, back);
    expect(form).toMatchObject({ type: "form", values: { text: "actual\nplan" }, back, fields: [{ name: "text", label: "Message text", multiline: true }] });
    expect(form.action).toEqual({ type: "access.context.save", agent, index: 1, blockIndex: 1, expectedMessage: original, expectedText: "actual\nplan", back });
    expect(form.action.expectedMessage).toBe(original);
    expect(form.details).toContain("Only this text block will change");
    expect(agent.context.at(1)).toBe(original);
  });

  test("editing and cancelling the form never mutate messages or attachments", () => {
    const agent = agentCreate([{ type: MessageType.User, content: [text("original"), { type: ContentType.Binary, content: "AA==", mimetype: "application/pdf", filename: "note.pdf" }] }]);
    const original = agent.context.at(0);
    const before = structuredClone(original);
    const back = viewer();
    const form = contextEditForm(agent, 0, undefined, back);
    const changed = updateForm(form, { type: "input.change", id: FORM_INPUT_PREFIX + "text", value: "not saved\nnew line" }).overlay;
    const cancelled = updateForm(changed, { type: "key", key: "escape" });
    expect(cancelled.cancel).toBe(true);
    expect(cancelled.overlay.values.text).toBe("not saved\nnew line");
    expect(cancelled.overlay.back).toBe(back);
    expect(agent.context.at(0)).toBe(original);
    expect(agent.context.at(0)).toEqual(before);
  });

  test("explicit saves edit only one block through Context and return the same back viewer", () => {
    const content = [
      { type: ContentType.Thinking, text: "plan", signature: "signed" }, text("first"),
      { type: ContentType.Binary, content: "AA==", mimetype: "application/pdf", filename: "note.pdf" },
      text("second"), { type: ContentType.ToolCall, callId: "call", name: "lookup", arguments: { query: "keep" }, signature: "keep" },
    ];
    const agent = agentCreate([assistant(content), user("later")]);
    const back = viewer();
    const form = contextEditForm(agent, 0, 3, back);
    const otherMessage = agent.context.at(1);
    const values = { text: "changed\nonly second" };
    const calls = [];
    const edit = agent.context.editBlock.bind(agent.context);
    agent.context.editBlock = (...args) => { calls.push(args); return edit(...args); };
    expect(applyContextSave(form.action, values)).toBe(back);
    expect(calls).toEqual([[0, 3, text("changed\nonly second")]]);
    expect(agent.context.at(0).content).toEqual([content[0], content[1], content[2], text("changed\nonly second"), content[4]]);
    expect(agent.context.at(1)).toBe(otherMessage);
    expect(values).toEqual({ text: "changed\nonly second" });
    expect(form.values.text).toBe("second");
  });

  test("default editing of multi-text user messages visibly limits the edit to the first block", () => {
    const agent = agentCreate([{ type: MessageType.User, content: [text("first"), { type: ContentType.Image, mimetype: "image/png", content: "AA==" }, text("second")] }]);
    const form = contextEditForm(agent);
    expect(form.values.text).toBe("first");
    expect(form.details).toContain("Only this text block will change");
    applyContextSave(form.action, { text: "" });
    expect(agent.context.at(0).content).toEqual([text(""), { type: ContentType.Image, mimetype: "image/png", content: "AA==" }, text("second")]);
  });

  test("stale message identity or in-place source text changes refuse saves and preserve parent form values/errors", () => {
    for (const replace of [true, false]) {
      const agent = agentCreate();
      const form = contextEditForm(agent);
      const entered = updateForm(form, { type: "input.change", id: FORM_INPUT_PREFIX + "text", value: "keep entered value" }).overlay;
      const failed = formErrors(entered, { text: "Parent validation error" });
      if (replace) agent.context.edit(0, user("changed elsewhere"));
      else agent.context.at(0).content[0].text = "changed elsewhere";
      const current = agent.context.at(0);
      expect(() => applyContextSave(failed.action, failed.values)).toThrow(/changed while editing/);
      expect(agent.context.at(0)).toBe(current);
      expect(agent.context.at(0).content[0].text).toBe("changed elsewhere");
      expect(failed.values.text).toBe("keep entered value");
      expect(failed.errors).toEqual({ text: "Parent validation error" });
    }
  });

  test("a save cannot be applied twice after successful Context replacement", () => {
    const agent = agentCreate();
    const form = contextEditForm(agent);
    applyContextSave(form.action, { text: "once" });
    expect(() => applyContextSave(form.action, { text: "twice" })).toThrow(/changed while editing/);
    expect(agent.context.at(0).content[0].text).toBe("once");
  });

  test("rejects non-text, empty, virtual, open and invalid message/block indexes without mutations", () => {
    const agent = agentCreate([user("original"), { type: MessageType.User, content: [{ type: ContentType.Image, mimetype: "image/png", content: "AA==" }] }]);
    const original = agent.context.messages();
    for (const index of [-1, 2, 0.5, "0", null]) expect(() => contextEditForm(agent, index)).toThrow();
    for (const index of [-1, 1, 0.5, "0", null]) expect(() => contextEditForm(agent, 0, index)).toThrow();
    expect(() => contextEditForm(agent, 1)).toThrow(/text\/thinking/);
    expect(() => contextEditForm(agentCreate([]))).toThrow();
    for (const flag of ["virtual", "open"]) {
      const marked = agentCreate([{ ...user("protected"), [flag]: true }]);
      expect(() => contextEditForm(marked)).toThrow(/persisted/);
    }
    const record = agentCreate([{ type: "io-root", model: "test/model" }]);
    expect(() => contextEditForm(record, 0)).toThrow(/persisted/);
    expect(agent.context.messages()).toEqual(original);
  });

  test("busy/closed changes between opening and saving are rejected", () => {
    for (const flag of ["busy", "closed", "closeMarked"]) {
      const agent = agentCreate();
      const form = contextEditForm(agent);
      const original = agent.context.at(0);
      agent[flag] = true;
      expect(() => contextEditForm(agent)).toThrow(/busy|closed|closing/);
      expect(() => applyContextSave(form.action, { text: "unsafe" })).toThrow(/busy|closed|closing/);
      expect(agent.context.at(0)).toBe(original);
      expect(original.content[0].text).toBe("original");
    }
  });

  test("invalid values/actions or vanished/non-text blocks are rejected before editing", () => {
    const agent = agentCreate();
    const form = contextEditForm(agent);
    for (const values of [undefined, {}, { text: 0 }, { text: null }]) expect(() => applyContextSave(form.action, values)).toThrow(/string/);
    expect(() => applyContextSave({ ...form.action, type: "access.context.delete" }, { text: "no" })).toThrow(/save action/);
    agent.context.at(0).content[0] = { type: ContentType.Image, mimetype: "image/png", content: "AA==" };
    expect(() => applyContextSave(form.action, { text: "no" })).toThrow(/no longer available/);
    expect(agent.context.at(0).content[0].type).toBe(ContentType.Image);
  });
});

describe("confirmed context mutations", () => {
  test("delete removes exactly the indexed message and rollback removes from the indexed message onward", () => {
    for (const [type, remaining] of [["access.context.delete", ["first", "third"]], ["access.context.rollback", ["first"]]]) {
      const agent = agentCreate([user("first"), user("second"), user("third")]);
      const back = viewer();
      const action = { type, agent, index: 1, expectedMessage: agent.context.at(1), viewer: back };
      expect(applyContextMutation(action)).toBe(back);
      expect(agent.context.messages().map((message) => message.content[0].text)).toEqual(remaining);
      expect(() => applyContextMutation(action)).toThrow();
    }
  });

  test("requires an actual nonnegative integer message index, never count/negative/virtual records", () => {
    for (const type of ["access.context.rollback", "access.context.delete"]) {
      const agent = agentCreate([user("first"), user("second")]);
      const before = agent.context.messages();
      for (const index of [-1, 2, 0.2, "0", undefined, null, Number.MAX_SAFE_INTEGER]) {
        expect(() => applyContextMutation({ type, agent, index })).toThrow();
        expect(agent.context.messages()).toEqual(before);
      }
      for (const flag of ["virtual", "open"]) {
        const protectedAgent = agentCreate([{ ...user("protected"), [flag]: true }]);
        expect(() => applyContextMutation({ type, agent: protectedAgent, index: 0 })).toThrow(/persisted/);
        expect(protectedAgent.context.length).toBe(1);
      }
    }
  });

  test("rechecks busy/closed state and confirmation-time message identity", () => {
    for (const type of ["access.context.rollback", "access.context.delete"]) {
      for (const flag of ["busy", "closed", "closeMarked"]) {
        const agent = agentCreate();
        const original = agent.context.at(0);
        agent[flag] = true;
        expect(() => applyContextMutation({ type, agent, index: 0, expectedMessage: original })).toThrow(/busy|closed|closing/);
        expect(agent.context.at(0)).toBe(original);
      }
      const agent = agentCreate();
      const original = agent.context.at(0);
      agent.context.edit(0, user("replacement"));
      expect(() => applyContextMutation({ type, agent, index: 0, expectedMessage: original })).toThrow(/changed before confirmation/);
      expect(agent.context.length).toBe(1);
      expect(agent.context.at(0).content[0].text).toBe("replacement");
    }
  });

  test("supports explicit index-only confirmations and refuses unrelated action types", () => {
    const agent = agentCreate();
    for (const type of ["access.context.fork", "access.context.save", "remove", undefined]) {
      expect(() => applyContextMutation({ type, agent, index: 0 })).toThrow(/rollback or delete/);
    }
    expect(agent.context.length).toBe(1);
    expect(applyContextMutation({ type: "access.context.delete", agent, index: 0 })).toBeUndefined();
    expect(agent.context.length).toBe(0);
  });
});
