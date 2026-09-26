/** Questionnaire domain state. Input editing, focus, layout, and pointer handling belong to GTUI controls. */

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new TypeError("questions must be a non-empty array");
  for (const question of questions) {
    if (!question || !Array.isArray(question.options)) throw new TypeError("each question must have an options array");
  }
}

/** Create model-owned questionnaire state without terminal or input-control state. */
export function createQuestionnaire(questions) {
  validateQuestions(questions);
  return { questions, index: 0, answers: [], drafts: [], selections: [], caret: 0, selection: null };
}

/** Return the descriptor currently presented by the application. */
export function currentQuestion(state) {
  return state.questions[state.index];
}

/** Move to a valid question index, retaining any unsubmitted custom draft. */
export function moveQuestion(state, index, draft) {
  if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) return state;
  const drafts = [...state.drafts];
  if (typeof draft === "string") drafts[state.index] = draft;
  return { ...state, index, drafts };
}

/** Current checkbox-style selections for a multi-select question. */
export function selectedLabels(state) {
  return [...(state.selections?.[state.index] ?? state.answers[state.index]?.labels ?? [])];
}

/** Toggle one valid label without coupling questionnaire state to menu geometry. */
export function toggleLabel(state, label) {
  const allowed = new Set(currentQuestion(state).options.map((option) => option.label));
  if (!allowed.has(label)) return state;
  const selections = [...(state.selections ?? [])];
  const selected = new Set(selectedLabels(state));
  if (selected.has(label)) selected.delete(label);
  else selected.add(label);
  selections[state.index] = [...selected];
  return { ...state, selections };
}

/** Record selected labels after validating them against the descriptor. */
export function answerWithLabels(state, labels) {
  const question = currentQuestion(state);
  const allowed = new Set(question.options.map((option) => option.label));
  const selected = [...new Set(labels)].filter((label) => allowed.has(label));
  const answer = question.multiSelect === true ? selected : selected.slice(0, 1);
  if (answer.length === 0) return { state, complete: false };
  return recordAnswer(state, { labels: answer });
}

/** Record typed text. On multi-select it augments the checked labels. */
export function answerWithText(state, text) {
  const value = String(text);
  const labels = currentQuestion(state).multiSelect === true ? selectedLabels(state) : [];
  return recordAnswer(state, labels.length > 0 ? { labels, text: value } : { text: value });
}

/** Abandon the current and every later unanswered question. */
export function abandonQuestions(state) {
  const answers = [...state.answers];
  for (let index = state.index; index < state.questions.length; index++) {
    if (answers[index] === undefined) answers[index] = { abandoned: true };
  }
  return { state: { ...state, answers }, complete: true, answers };
}

function recordAnswer(state, answer) {
  const answers = [...state.answers];
  answers[state.index] = answer;
  const drafts = [...state.drafts];
  delete drafts[state.index];
  const selections = [...(state.selections ?? [])];
  if (answer.labels) selections[state.index] = [...answer.labels];
  else delete selections[state.index];
  const next = state.questions.findIndex((_, index) => index > state.index && answers[index] === undefined);
  const model = { ...state, answers, drafts, selections, index: next < 0 ? state.index : next };
  const complete = state.questions.every((_, index) => answers[index] !== undefined);
  return { state: model, complete, ...(complete ? { answers } : {}) };
}
