/** app-view: Synchronous GTUI application view composition. */
import { view as v } from "../gtui/gtui.js";
import { questionView, QUESTION_MENU_ID } from "./questionnaire-view.js";
import { currentQuestion, selectedLabels } from "./questionnaire.js";
import { overlayView } from "./overlay-view.js";
import { noticeItems } from "./transcript.js";
import { statusData } from "./status-data.js";
import { statusView } from "./status-view.js";
import { informationData } from "./information-data.js";
import { informationView } from "./information-view.js";
import { queueView } from "./queue-view.js";
import { welcomeView } from "./welcome-view.js";
import { attachmentChips, attachmentPaste } from "./attachment-draft.js";
import { formatBytes } from "../shared/format.js";
import { TRANSCRIPT_SCROLL_ID } from "./transcript-navigation.js";
const EXIT_NOTICE_TEXT = "press ^C again to exit";
import { NAMES } from "../../namespace.js";

export function createAppView({ refreshProjection, blocksFor, allBlocksFor, projection, viewed, completionSources, terminalHeight, terminalWidth, env, cwd }) {
  /** Reads agent.context live through the slot (Agent, not the model,
   *  owns the conversation) and stays synchronous throughout.
   * @param {object} model - the app model
   * @returns {object} the GTUI view tree (question/overlay takeover, or the
   *   transcript feed with footer, queue, attachment chips, input, status)
   */
  function view(model) {
    // Menus and questions are true viewport takeovers in BOTH modes.
    // Do not build or lay out the transcript/footer behind either one;
    // inline vs alt is only a host rendering choice.
    if (model.question) {
      const view = questionView(
        currentQuestion(model.question.state), model.question.draft, model.question.focus,
        selectedLabels(model.question.state), model.question.menuTarget,
        model.question.caret, model.question.selection, model.question.highlight, model.question.reading === true,
        model.question.state.questions.some((_, index) => index > model.question.state.index && model.question.state.answers[index] === undefined),
      );
      // The Submit-row jump must survive re-renders: a per-render
      // menuTarget-derived stateKey hands GTUI a fresh menu each frame
      // (Enter never sees the highlight), so once the target latches
      // into model.question.menuToken it drives the menu's stateKey.
      if (model.question.menuToken === undefined) return view;
      const menu = view.children[0].children.find((node) => node.id === QUESTION_MENU_ID);
      const patched = view.children[0].children.map((node) => node === menu ? { ...menu, stateKey: model.question.menuToken } : node);
      return { ...view, children: [{ ...view.children[0], children: patched }] };
    }
    if (model.overlay?.type === "menu" || model.overlay?.type === "viewer-filter") return overlayView(model.overlay, []);

    refreshProjection();
    if (model.overlay?.type === "viewer") return overlayView(model.overlay, blocksFor(model));
    const blocks = allBlocksFor(model);

    const transcript = projection.projector.project(blocks, 1, { running: model.turnRunning === true });
    const boundary = blocks.findIndex((block) => block.type !== "system");
    const leading = boundary < 0 ? transcript.length : boundary;
    const available = terminalHeight() - 6;
    const welcome = { key: "startup-banner", done: true, node: available < 18
      ? v.text({ role: "accent md.strong", overflow: "clip-end" }, `${NAMES.Namespace} · ${viewed.model ?? "(none)"}`)
      : welcomeView({ model: viewed.model,
        prompts: completionSources.catalog?.()?.prompts ?? [], width: terminalWidth(),
        compact: available < 25, topSpace: available >= 28 ? 2 : 0 }) };
    const items = [...transcript.slice(0, leading), welcome, ...transcript.slice(leading),
      ...noticeItems(model.notices, Math.max(projection.projector.ceiling(), 1 + transcript.length))];
    // The transcript is the one row that should shrink first when the
    // terminal can't fit everything (an oversized system prompt, a
    // very long reply) — footer controls remain usable and visible.
    const statusFacts = statusData({ agent: viewed, env, cwd, catalog: completionSources.catalog?.() });
    const status = v.column({ priority: 20 }, [statusView(statusFacts, { focus: model.focus === "toolbar", key: model.toolbarKey })]);
    const input = model.input;
    const box = v.input({
      id: "draft", value: input.value, caret: input.caret, selection: input.selection,
      disabled: model.closedInput || viewed.closeMarked === true,
      completions: input.completions, completionIndex: input.completionIndex,
      // Bracketed paste identifies paste but not a terminal drop. This
      // conservative transform recognizes only a whole absolute pathname.
      pasteTransform: (text) => attachmentPaste(text, { cwd: env?.cwd ?? cwd }),
      focus: !model.question && model.focus !== "toolbar", active: statusFacts.viewedWorking, priority: 10,
      placeholder: statusFacts.viewedWorking ? "Queue a message for the agent…" : "Ask anything · / for commands",
    });
    const rows = [v.scroll({ id: TRANSCRIPT_SCROLL_ID, anchor: "end", offset: model.transcriptOffset, keyboard: true, priority: 0 }, [v.feed({ id: projection.feedId, items })])];
    // Live tool output is rendered in the transcript as an open tool block,
    // like thinking; the footer remains for sticky tool information/status.
    const information = informationData(viewed, env, undefined, completionSources.catalog?.());
    if (information.length > 0) rows.push(v.column({ priority: 5 }, [informationView(information)]));
    const queue = queueView(viewed);
    if (queue) rows.push(queue);
    const chips = attachmentChips(input.value);
    if (chips.length > 0) rows.push(v.text({ role: "notice", overflow: "clip-end", priority: 10 }, chips.flatMap((chip, index) => [
      ...(index > 0 ? [{ text: "   " }] : []),
      chip.missing ? { text: `📎 ${chip.name} · missing`, role: "notice.error" } : { text: `📎 ${chip.name} · ${formatBytes(chip.size)}` },
    ])));
    rows.push(box);
    if (model.exitNotice) rows.push(v.text({ role: "notice.action", priority: 10 }, EXIT_NOTICE_TEXT));
    // The shared status block follows the writing/question input in inline
    // and alt alike and closes the view.
    rows.push(status);
    return v.column({ viewportFill: true, rows: ["fill", ...rows.slice(1).map(() => "auto")] }, rows);
  }

  return view;
}
