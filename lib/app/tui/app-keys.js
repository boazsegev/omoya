/** app-keys: Immediate keyboard and shortcut routing for the TUI app. */
import { effect } from "../gtui/gtui.js";
import { insertText, cycleCompletions, acceptCompletion, dismissCompletions, openCompletions, recallDrained, navigateHistory, selectedText, clearInput } from "./input-controller.js";
import { openMenu, openViewer, moveViewer, hopViewer } from "./overlay-controller.js";
import { masterMenuOptions, endpointMenuOptions, modelMenuOptions } from "./menu-sources.js";
import { buildMenuItems, buildEndpointItems, buildProviderItems } from "./contracts.js";
import { currentQuestion, moveQuestion, abandonQuestions } from "./questionnaire.js";

export function createKeyHandler({ mapped, pageAgent, attachViewedLive, switchParentAgent, blocksFor, viewed, adapter, completionSources, sources, pathRequest, pathCompletionEffect, nextCopySequence, requestQuit, statusAction, refreshCompletionCatalogEffect, combo, env, notify, slot, updateQuestion }) {
  /** Every keyboard (and action.select) message: shortcut hints are
   *  rewritten to keys, then the first matching guard claims it — toolbar
   *  focus, session paging/fork, interrupt/exit policy, completions,
   *  history, copy, overlay menus/viewer, and the questionnaire.
   * @param {object} model - the app model
   * @param {object} message - a "key" message ({key, text?}) or an
   *   action.select whose action starts with "shortcut."
   * @returns {{model: object, effects: Array<object>}} the next state
   */
  function key(model, message) {
    // A clicked hint IS its key: convert before any key handling, so it
    // takes exactly the path the key would (Esc interrupt, ↓ history/toolbar).
    if (!model.question && !model.overlay && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("shortcut.")) {
      message = { type: "key", key: message.action.slice("shortcut.".length) };
    }
    const input = model.input;
    // The status toolbar holds focus below the input. GTUI roves between its
    // chips; every key it declines lands here: Up/Esc return to the input
    // (Esc closes this innermost layer before a further Esc interrupts), and
    // typing returns there WITH the typed text, so no keystroke is lost.
    if (model.focus === "toolbar" && !model.overlay && !model.question && message.type === "key") {
      if (message.key === "up" || message.key === "escape") return { model: { ...model, focus: "input" }, effects: [] };
      if (typeof message.text === "string" && message.text !== "") return { model: { ...model, focus: "input", input: insertText(input, message.text) }, effects: [] };
    }
    if (!model.question && mapped("previousSession", message.key)) {
      return pageAgent(-1) ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && mapped("nextSession", message.key)) {
      return pageAgent(1) ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && message.key === "alt+ctrl+up") {
      return switchParentAgent() ? { model: { ...attachViewedLive(model), overlay: null }, effects: [] } : { model, effects: [] };
    }
    if (!model.question && mapped("fork", message.key)) {
      const blocks = blocksFor(model);
      const selected = blocks[Math.max(0, Math.min(model.overlay?.index ?? 0, blocks.length - 1))];
      const through = model.overlay?.type === "viewer" && !selected?.virtual
        ? (selected?.message ?? viewed.context.length - 1) + 1
        : viewed.context.length;
      // Fork is a session-store operation on the current agent. When invoked through the viewer, truncate to the selected
      // message first; Agent.fork closes the prior store and snapshots this
      // context into the replacement store without retaining another agent.
      if (through < viewed.context.length) viewed.context.rollback(through);
      viewed.contextFork();
      return { model: { ...attachViewedLive(model), overlay: null }, effects: [] };
    }
    // Esc interrupts the displayed agent when it is running; idle Esc
    // retains its usual draft, viewer, or question navigation behavior.
    // Anything open (menu, viewer, question, completions) is dismissed
    // first even mid-turn: Esc closes the innermost layer, and a further
    // Esc interrupts.
    if (message.key === "escape" && !model.turnRunning && !model.overlay && !model.question) {
      // Esc also invalidates a pending lookup before it has a visible popup.
      if (input.completions.length === 0) return { model: { ...model, completionGeneration: model.completionGeneration + 1 }, effects: [] };
    }
    if (message.key === "escape" && model.turnRunning && !model.overlay && !model.question && input.completions.length === 0) {
      return { model, effects: [adapter.interruptEffect()] };
    }
    if (input.completions.length > 0 && !model.question) {
      if (message.key === "tab" || message.key === "down") return { model: { ...model, input: cycleCompletions(input, 1) }, effects: [] };
      if (message.key === "shift+tab" || message.key === "up") return { model: { ...model, input: cycleCompletions(input, -1) }, effects: [] };
      if (message.key === "enter") return { model: { ...model, input: acceptCompletion(input) }, effects: [] };
      if (message.key === "escape") return { model: { ...model, input: dismissCompletions(input) }, effects: [] };
    }
    if (!model.question && !model.overlay && (message.key === "tab" || message.key === "shift+tab")) {
      const opened = openCompletions(input, completionSources);
      // Opening is itself a preview: Tab selects the first choice, while
      // Shift+Tab selects the last. Subsequent navigation is handled above.
      const next = opened.completions.length > 0
        ? cycleCompletions(opened, message.key === "shift+tab" ? -1 : 0)
        : opened;
      // Runtime filesystem discovery is asynchronous; injected listDir sources
      // remain synchronous for deterministic callers and tests.
      // A request nonce distinguishes repeated explicit Tabs on the exact
      // same draft; generation alone only distinguishes an edited draft.
      const nonce = model.completionRequest + 1;
      const path = sources === undefined && next.completions.length === 0 ? pathRequest(input) : null;
      const request = path
        ? { ...path, generation: model.completionGeneration, nonce, direction: message.key === "shift+tab" ? -1 : 0 }
        : null;
      return { model: { ...model, input: next, completionRequest: request ? nonce : model.completionRequest }, effects: request ? [pathCompletionEffect(request)] : [] };
    }
    if (message.key === "alt+shift+up") return { model: { ...model, input: recallDrained(input, viewed.pendingPop?.() ?? [], completionSources) }, effects: [] };
    if (!model.overlay && !model.question && (message.key === "up" || message.key === "down")) {
      const nextInput = navigateHistory(input, message.key === "up" ? -1 : 1, completionSources);
      // Down past the newest draft moves focus to the setting toolbar right
      // below the input (↑ comes back).
      if (nextInput === input && message.key === "down" && model.focus !== "toolbar") return { model: { ...model, focus: "toolbar" }, effects: [] };
      // At a visual boundary with no history to enter/leave, Up/Down is a
      // genuine no-op. Preserve model identity so inline mode emits no
      // pointless border/status repaint.
      return nextInput === input ? { model, effects: [] } : { model: { ...model, input: nextInput }, effects: [] };
    }
    if (message.key === "copy" && !model.overlay && !model.question) {
      // Mouse transcript selection primes model.transcriptSelection (GTUI
      // forwards it through selection.change); it copies through the very
      // same Copy key an input keyboard selection uses, never a separate
      // mouse-only channel.
      const transcript = model.transcriptSelection;
      if (transcript) return { model: { ...model, transcriptSelection: null }, effects: [effect.copy(transcript, `transcript-copy:${nextCopySequence()}`)] };
      const text = selectedText(model.input);
      return text === ""
        ? { model, effects: [] }
        : { model, effects: [effect.copy(text, `input-copy:${nextCopySequence()}`)] };
    }
    // Ctrl+C's plain meaning (parity with lib/tui-helpers/input-keys.js's
    // IS_INTERRUPT branch): a turn in flight cancels; otherwise it's a
    // TUI-only gesture — a non-empty draft clears, an empty one shows
    // "press ^C again to exit" and a SECOND press (still empty, still
    // idle) actually quits. The overlay/viewer/question guards below
    // claim ctrl+c for their own close/abandon meaning FIRST when one
    // of those is actually open.
    if (message.key === "ctrl+c" && !model.overlay && !model.question) {
      if (model.turnRunning) return { model, effects: [adapter.interruptEffect()] };
      if (model.input.value !== "") return { model: { ...model, input: clearInput(model.input) }, effects: [] };
      if (model.exitNotice) return requestQuit(model);
      return { model: { ...model, exitNotice: true }, effects: [] };
    }
    // Ctrl+D: EOF on an empty draft quits — DELIBERATELY regardless of
    // model.turnRunning (parity with lib/tui-helpers/input-keys.js's
    // IS_EOF branch, which has no busy guard either: EOF ends the
    // session even mid-turn, unlike ^C which only ever cancels or
    // clears while busy). A non-empty draft forward-deletes instead
    // (never EOFs mid-edit).
    if (message.key === "ctrl+d" && !model.overlay && !model.question) {
      if (model.input.value === "") return requestQuit(model);
      // A focused GTUI input consumes non-empty Ctrl+D as its generic
      // forward-delete operation before this app-level EOF policy runs.
      return { model, effects: [] };
    }

    if (!model.question && (!model.overlay || model.overlay.type === "viewer") && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("code.copy:")) {
      const match = /^code\.copy:(.+):(\d+):(\d+)$/.exec(message.action);
      const block = match && blocksFor(model).find((item) => `${item.group}:${item.section ?? item.type}:${item.ordinal ?? 0}` === match[1]);
      const start = match ? Number(match[2]) : NaN;
      const end = match ? Number(match[3]) : NaN;
      if (!block || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > (block.text ?? "").length) return { model, effects: [] };
      return { model, effects: [effect.copy(block.text.slice(start, end), `code-copy:${nextCopySequence()}`)] };
    }
    if (!model.question && !model.overlay && message.type === "action.select" && typeof message.action === "string" && message.action.startsWith("status.")) {
      return statusAction(model, message.action.slice("status.".length));
    }
    if (!model.question && message.key === "ctrl+x") {
      return { model: { ...model, overlay: model.overlay ? null : openMenu("Menu", buildMenuItems(masterMenuOptions(viewed, env, combo(), { catalog: completionSources.catalog?.() }))) }, effects: [refreshCompletionCatalogEffect()] };
    }
    if (!model.question && message.key === "ctrl+p") {
      return { model: { ...model, overlay: model.overlay ? null : openMenu("Endpoints", buildEndpointItems(endpointMenuOptions(env, combo()))) }, effects: [] };
    }
    if (!model.question && message.key === "ctrl+m") {
      if (model.overlay) return { model: { ...model, overlay: null }, effects: [] };
      const options = modelMenuOptions(viewed, env);
      if (!options) {
        const notified = notify(model, { text: "no endpoint connected — pick one with ^P (the endpoint menu)", kind: "notice" });
        return { model: { ...model, notices: notified.notices }, effects: notified.effects };
      }
      return { model: { ...model, overlay: openMenu(options.value, buildProviderItems(options)) }, effects: [] };
    }
    if (!model.question && message.key === "ctrl+o") {
      const blocks = blocksFor(model);
      return { model: { ...model, overlay: model.overlay?.type === "viewer" ? null : openViewer(blocks) }, effects: [] };
    }
    if (model.overlay?.type === "viewer") {
      const blocks = blocksFor(model);
      if (message.key === "left") return { model: { ...model, overlay: moveViewer(model.overlay, blocks, -1) }, effects: [] };
      if (message.key === "right") return { model: { ...model, overlay: moveViewer(model.overlay, blocks, 1) }, effects: [] };
      if (message.key === "alt+left") return { model: { ...model, overlay: hopViewer(model.overlay, blocks, -1) }, effects: [] };
      if (message.key === "alt+right") return { model: { ...model, overlay: hopViewer(model.overlay, blocks, 1) }, effects: [] };
      if (message.key === "f") return { model: { ...model, overlay: { type: "viewer-filter", viewer: model.overlay, filters: [...(model.overlay.filters ?? [])], draft: model.overlay.search ?? "", focus: "menu" } }, effects: [] };
      if (message.key === "c") {
        const block = blocks[Math.max(0, Math.min(model.overlay.index, blocks.length - 1))];
        return block
          ? { model, effects: [effect.copy(block.text ?? "", `viewer-copy:${nextCopySequence()}`)] }
          : { model, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, overlay: null }, effects: [] };
    }
    if (model.overlay?.type === "viewer-filter") {
      // A Tab keypress (no printable text) swaps focus between the option
      // menu and the search input; text arriving WHILE the input is focused
      // still inserts a tab character like in every other text editor.
      if (message.key === "tab" && !(model.overlay.focus === "input" && typeof message.text === "string" && message.text !== "")) {
        return { model: { ...model, overlay: { ...model.overlay, focus: model.overlay.focus === "menu" ? "input" : "menu" } }, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, overlay: model.overlay.viewer }, effects: [] };
    }
    if (model.question) {
      if (model.question.reading === true) {
        if (message.key === "escape" || message.key === "ctrl+c") return { model: { ...model, question: { ...model.question, reading: false } }, effects: [] };
        return { model, effects: [] };
      }
      if (model.question.focus === "menu" && typeof message.text === "string" && message.text !== "") {
        const state = model.question.state;
        const selections = [...(state.selections ?? [])];
        if (currentQuestion(state).multiSelect !== true) selections[state.index] = [];
        const draft = model.question.draft ?? "";
        return { model: { ...model, question: { ...model.question, focus: "input", menuTarget: null, caret: draft.length + message.text.length, selection: null,
          state: { ...state, selections }, draft: `${draft}${message.text}` } }, effects: [adapter.resetTimeoutEffect()] };
      }
      // A Tab keypress (no printable text) swaps focus between the option
      // menu and the custom-answer input; text arriving WHILE the input is
      // focused still inserts a tab character like in every other editor.
      if (message.key === "tab" && !(model.question.focus === "input" && typeof message.text === "string" && message.text !== "")) {
        return { model: { ...model, question: { ...model.question, focus: model.question.focus === "menu" ? "input" : "menu", menuTarget: null } }, effects: [] };
      }
      if (message.key === "alt+ctrl+left" || message.key === "alt+ctrl+right") {
        const state = model.question.state;
        const last = state.questions.length - 1;
        const nextIndex = Math.max(0, Math.min(last, state.index + (message.key === "alt+ctrl+right" ? 1 : -1)));
        const nextState = moveQuestion(state, nextIndex, model.question.draft);
        return { model: { ...model, question: { ...model.question, state: nextState, draft: nextState.drafts[nextState.index] ?? "" } }, effects: [adapter.resetTimeoutEffect()] };
      }
      // Crossing the custom-answer input's OWN boundary returns focus to
      // the menu: GTUI's vertical editing move BUBBLES at the first/last
      // visual row (single-line drafts always), and the bubbled ↑/↓
      // crosses back to the option rows / Submit — the same gesture the
      // menu's own arrows perform. Tab keeps its explicit swap.
      if (model.question.focus === "input" && (message.key === "up" || message.key === "down")) {
        const toSubmit = message.key === "up";
        return { model: { ...model, question: { ...model.question, focus: "menu", menuTarget: toSubmit ? "submit" : null,
          menuToken: toSubmit ? `${currentQuestion(model.question.state).header}:submit` : undefined } }, effects: [] };
      }
      if (message.key === "escape" || message.key === "ctrl+c") return updateQuestion(model, abandonQuestions(model.question.state));
    }
    return { model, effects: [] };
  }

  return key;
}
