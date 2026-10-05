/** Question dialog behavior over explicit DOM helpers (no globals at import).
 * Selection, previews, digit/arrow keys, and Submit/Esc answers; the caller
 * opens the dialog and owns pending-question state through `settle`. */

/**
 * Fill an opened question dialog and wire its answers.
 * @param {{dialog: HTMLDialogElement, body: HTMLElement, head: HTMLElement}} view - opened dialog parts.
 * @param {{requestId: string, questions: object[]}} question - pending question packet.
 * @param {{el: Function, button: Function, markdownNode: Function, send: Function, settle: Function, document: Document}} deps
 *   DOM helpers, the packet sender, and `settle()`, which clears the pending question and
 *   returns whether it was still pending (a server-closed dialog sends no refusal).
 * @returns {void}
 */
export function buildQuestionDialog({ dialog, body, head }, question, { el, button, markdownNode, send, settle, document }) {
  const requestId = question.requestId;
  // Esc / closing without an answer refuses (null), like the TUI's ^C.
  let answered = false;
  dialog.addEventListener("close", () => { if (!answered && settle()) send({ type: "question.answer", requestId, answers: null }); });
  head.querySelector("h2")?.prepend(el("span", "question-badge", "?"));
  const states = question.questions.map(() => ({ labels: new Set(), text: "" }));
  const submit = button("primary-button question-submit", "Submit answers", null);
  submit.title = "Focus Submit answers, then press Enter";
  const refresh = () => {
    const ready = states.every((state) => state.labels.size || state.text.trim());
    submit.disabled = !ready;
    submit.textContent = ready ? "Submit answers" : `Answer ${states.filter((state) => !state.labels.size && !state.text.trim()).length} more`;
  };
  question.questions.forEach((q, qi) => {
    const section = el("section", "question");
    if (question.questions.length > 1 && q.header) section.append(el("h3", "question-header", q.header));
    section.append(el("p", "question-text", q.question ?? ""));
    if (q.details) section.append(markdownNode("div", "md question-details", q.details));
    if (q.multiSelect) section.append(el("p", "muted small", "Select all that apply"));
    const list = el("div", "question-options");
    list.setAttribute("role", q.multiSelect ? "group" : "radiogroup");
    // Preview is tied to the selected answer, never pointer position or focus.
    // Reserve its space so selecting another answer cannot move the dialog.
    const previewPane = el("div", "question-preview-pane");
    previewPane.hidden = !(q.options ?? []).some((option) => option.preview !== undefined);
    previewPane.append(el("p", "muted small", "Pick an option to preview it"));
    const showPreview = () => {
      const label = [...states[qi].labels].at(-1);
      const choice = (q.options ?? []).find((option) => option.label === label);
      const preview = choice?.preview === undefined ? null : typeof choice.preview === "string" ? { type: "text", content: choice.preview } : choice.preview;
      previewPane.replaceChildren();
      if (!preview) { previewPane.append(el("p", "muted small", label ? "No preview for this option" : "Pick an option to preview it")); return; }
      if (preview.title) previewPane.append(el("div", "question-preview-title", preview.title));
      previewPane.append(preview.type === "code" ? el("pre", "question-preview", preview.content ?? "") : markdownNode("div", "md question-preview", preview.content ?? ""));
    };
    (q.options ?? []).forEach((option, oi) => {
      const btn = el("button", "question-option");
      btn.type = "button";
      btn.dataset.label = option.label ?? "";
      if (!q.multiSelect) btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.title = oi + 1 <= 9 ? `Select (key ${oi + 1})` : "Select";
      const key = el("span", "option-key", String(oi + 1));
      const text = el("span", "option-text");
      text.append(el("span", "question-option-label", option.label ?? ""));
      if (option.description) text.append(el("span", "question-option-description", option.description));
      btn.append(key, text);
      if (option.preview !== undefined) btn.append(el("span", "option-has-preview", "preview"));
      btn.addEventListener("click", () => {
        const state = states[qi];
        if (q.multiSelect) { if (state.labels.has(btn.dataset.label)) state.labels.delete(btn.dataset.label); else state.labels.add(btn.dataset.label); }
        else { state.labels = new Set([btn.dataset.label]); }
        list.querySelectorAll(".question-option").forEach((button) => {
          const selected = state.labels.has(button.dataset.label);
          button.classList.toggle("selected", selected);
          button.setAttribute("aria-checked", String(selected));
        });
        showPreview();
        refresh();
      });
      list.append(btn);
    });
    const other = el("input", "question-other");
    other.placeholder = q.multiSelect ? "Add a note (optional)" : "Or type your own answer";
    other.setAttribute("aria-label", `Custom answer for: ${q.question ?? "question"}`);
    other.addEventListener("input", () => {
      states[qi].text = other.value;
      if (!q.multiSelect && other.value.trim()) { states[qi].labels.clear(); list.querySelectorAll(".question-option").forEach((b) => { b.classList.remove("selected"); b.setAttribute("aria-checked", "false"); }); showPreview(); }
      refresh();
    });
    other.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
    section.append(list, previewPane, other);
    body.append(section);
  });
  // Native button activation owns Enter/Space: the focused option selects,
  // while only the focused Submit button sends. Dialog owns Esc and Tab.
  dialog.addEventListener("keydown", (event) => {
    const typing = event.target.matches?.("input, textarea, select") || event.target.isContentEditable;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing) return;
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      // Flatten across questions: the Nth key picks the Nth option overall.
      // Submit receives focus only after every question has an answer.
      const chosen = [...body.querySelectorAll(".question-option")][n - 1];
      if (chosen) {
        event.preventDefault();
        chosen.click();
        if (!submit.disabled) submit.focus();
        else chosen.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const options = [...body.querySelectorAll(".question-option")];
      if (!options.length) return;
      event.preventDefault();
      const at = options.indexOf(document.activeElement);
      const next = event.key === "ArrowDown"
        ? (at < 0 ? 0 : Math.min(options.length - 1, at + 1))
        : (at < 0 ? options.length - 1 : Math.max(0, at - 1));
      options[next].focus();
      return;
    }
  });
  const questionActions = el("div", "question-actions");
  submit.addEventListener("click", () => {
    const answers = states.map((state) => {
      const labels = [...state.labels];
      const text = state.text.trim();
      if (labels.length && text) return { labels, text };
      if (labels.length) return { labels };
      if (text) return { text };
      return { abandoned: true };
    });
    answered = true;
    send({ type: "question.answer", requestId, answers });
    settle();
    dialog.close();
  });
  const dismissBtn = button("chip question-dismiss", "Dismiss", () => dialog.close(), { title: "Refuse to answer (Esc)" });
  const hasOptions = question.questions.some((q) => (q.options ?? []).length > 0);
  questionActions.append(el("span", "muted small question-keys", `${hasOptions ? "1–9 select, then Enter to submit · ↑/↓ move · Enter/Space select focused · " : ""}Tab to Submit · Esc dismiss`), dismissBtn, submit);
  body.append(questionActions);
  refresh();
  body.querySelector(".question-option")?.focus();
}
