/**
 * lib/tui-app/questionnaire-view.js — the open question (agent-adapter.js's
 * question bridge + questionnaire.js's pure state) into GTUI nodes: the
 * options render through the SAME controlled `menu` used everywhere
 * else (arrow/enter/escape are native), plus a real `input` for a
 * custom typed answer — parity with test/cli-question.test.js's "the
 * custom-answer line is a real text input".
 *
 * Enter and Space both select/toggle the focused row. On a single-select
 * answer Enter also moves the highlight to the Submit row for
 * confirmation (the input's Enter does the same jump). Only selecting
 * the final submit row commits the answer. The question text, option
 * labels, and option DESCRIPTIONS all SOFT-WRAP (labels through the
 * menu's own word-wrap; descriptions as their own wrapped text nodes),
 * so nothing clips at the overlay edge. A description/preview belongs
 * to the option: it shows ONLY while that option is the HIGHLIGHTED
 * menu row (tui-app tracks menu.change into question.highlight), so
 * extra information never floods the overlay. A code preview renders
 * through the shared markdown pipeline (fenced block) — the same
 * highlighting the transcript uses. Crossing the input's top row with
 * ↑ (or its bottom with ↓) returns focus to the menu (tui-app's key
 * policy on GTUI's bubbled boundary move). GTUI still owns only
 * generic menu navigation/selection and never sees questionnaire state.
 */

import { view } from "../gtui/gtui.js";
import { markdownRows } from "./markdown-view.js";

export const QUESTION_MENU_ID = "question-menu";
export const QUESTION_INPUT_ID = "question-input";

/** The extra information attached to one highlighted option: its
 *  description, then a plain-text or fenced-code preview through the
 *  shared markdown pipeline (same roles/highlighting as the transcript).
 *  Row SPANS carry their own md roles, so each becomes its own text node
 *  (a whole row as one content string would flatten the highlighting). */
function previewRows(preview) {
  if (!preview) return [];
  const content = typeof preview === "string" ? preview : String(preview.content ?? "");
  if (content === "") return [];
  const text = (typeof preview === "object" && preview.type === "code")
    ? `\`\`\`${preview.language ?? ""}\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``
    : content;
  return markdownRows(text).map((row) => view.text({ role: "question.preview", priority: 7 }, row.content));
}

/**
 * @param {object} question - questionnaire.js's currentQuestion(state) result
 * @param {string} draft - the in-progress custom-answer text (questionnaire.js's per-index draft)
 * @param {"menu"|"input"} focus - which control Tab last switched to (only ONE
 *   GTUI control may carry `focus: true` at a time — see lib/gtui/controls.js's
 *   drawControl, which tracks the LAST-drawn focused node)
 * @param {number} caret - the custom-answer input's controlled caret index
 * @param {object|null} selection - its controlled {anchor, caret} selection
 * @returns {object} a GTUI overlay node
 */
export function questionView(question, draft = "", focus = "menu", selected = [], menuTarget = null, caret = undefined, selection = null, highlight = null, reading = false, hasNext = false) {
  if (reading) {
    const optionRows = question.options.flatMap((option, index) => {
      const preview = option.preview;
      const previewText = typeof preview === "string" ? preview : String(preview?.content ?? "");
      const previewTitle = typeof preview === "object" && preview?.title ? String(preview.title) : "";
      const previewLanguage = typeof preview === "object" && preview?.language ? String(preview.language) : "";
      return [
        view.text({ role: "question.option" }, `${index + 1}. ${option.label}`),
        view.text({ role: "question.details" }, option.description),
        ...(previewTitle ? [view.text({ role: "question.details" }, `Preview: ${previewTitle}`)] : []),
        ...(previewLanguage ? [view.text({ role: "question.details" }, `Language: ${previewLanguage}`)] : []),
        ...(previewText ? [view.text({ role: "question.preview" }, previewText)] : []),
        view.text({ role: "question.details" }, ""),
      ];
    });
    return view.overlay({ fill: true }, [view.scroll({
      id: "question-reader", focus: true, title: ` ${question.header} — full question `,
      footer: " ↑ ↓ / Space / wheel scroll · Esc back to answers ",
    }, [view.column({}, [
      view.text({ role: "question.text" }, question.question),
      ...(question.details ? [view.text({ role: "question.details" }, question.details)] : []),
      view.text({ role: "question.details" }, `Multiple answers: ${question.multiSelect === true ? "yes" : "no"}`),
      view.text({ role: "question.details" }, ""),
      ...optionRows,
    ])])]);
  }
  const chosen = new Set(selected);
  const mark = (isChosen) => question.multiSelect === true
    ? (isChosen ? "[x]" : "[ ]")
    : (isChosen ? "(●)" : "( )");
  const items = [
    ...question.options.map((option) => ({
    kind: "action",
    label: `${mark(chosen.has(option.label))} ${option.label}`,
    value: { type: "question.toggle", label: option.label },
  })),
  ];
  items.push({ kind: "action", label: `${mark(draft !== "")} Type something:`, value: { type: "question.custom" } });
  items.push({ kind: "header", label: "" });
  items.push({ kind: "action", label: hasNext ? "Next" : "Submit", value: { type: "question.submit" } });
  items.push({ kind: "action", label: "Read question/details", value: { type: "question.read" } });
  // Prompt prose gets a useful wrapped preview, but loses space before the
  // answer controls on small terminals. The Read row always opens the full,
  // scrollable question/details view.
  const header = view.column({ maxRows: 3, head: 1, overflow: "tail", ellipsis: true, priority: 1 }, [
    view.text({ role: "question.text" }, question.question),
    ...(question.details ? [view.text({ role: "question.details" }, question.details)] : []),
  ]);
  // The menu owns navigation; the extra information follows the
  // HIGHLIGHTED row: a description the option carries shows only while
  // that option is highlighted, and its optional preview (plain text,
  // or code with a language) renders right after it. Un-highlighted
  // options stay one clean row each, so a long description or a code
  // snippet never squeezes the options/Submit rows out of the overlay.
  // The menu opens on its first selectable row without emitting a
  // menu.change, so a null highlight defaults to that same first option.
  const wanted = highlight ?? (menuTarget === "submit" ? null : question.options[0]?.label ?? null);
  const highlighted = wanted === null || !question.options.some((option) => option.label === wanted)
    ? null
    : question.options.find((option) => option.label === wanted);
  const preview = highlighted?.preview;
  const previewTitle = typeof preview === "object" && preview?.title ? String(preview.title) : "";
  const extra = highlighted === null ? [] : [
    view.text({ role: "question.preview", priority: 0 }, ""),
    ...(highlighted.description ? [view.text({ role: "question.details", priority: 1 }, highlighted.description)] : []),
    ...(previewTitle ? [
      view.text({ role: "question.preview", priority: 1 }, previewTitle),
      view.text({ role: "question.preview", priority: 0 }, ""),
    ] : []),
    ...previewRows(preview),
  ];
  return view.overlay({ fill: true }, [
    view.column({}, [
      header,
      view.menu({
        id: QUESTION_MENU_ID, title: question.header, items, focus: focus === "menu", priority: 100,
        filter: false, bubbleText: true, initialIndex: menuTarget === "submit" ? question.options.length + 2 : undefined,
        stateKey: `${question.header}:${menuTarget ?? "answers"}`, selectOnSpace: true, submitOnEnter: false,
      }),
      view.input({ id: QUESTION_INPUT_ID, value: draft, caret, selection, placeholder: "Type something (typing focuses here):", focus: focus === "input", priority: 50, maxRows: 8, bubbleKeys: ["up", "down"] }),
      view.text({ role: "question.details", priority: 50 }, `Type for custom · Enter → ${hasNext ? "Next" : "Submit"} · Shift+Enter line break · ↑/↓ choose · Space select · Esc cancel`),
      ...extra,
    ]),
  ]);
}
