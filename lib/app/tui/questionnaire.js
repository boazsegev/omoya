/** Questionnaire domain state. Input editing, focus, layout, and pointer handling belong to GTUI controls. */

/**
 * Validate the questionnaire descriptors before creating model state.
 * @param {unknown} questions Candidate non-empty array of question descriptors.
 * @returns {void}
 * @throws {TypeError} If the value is not a non-empty array or a question lacks an options array.
 */
function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new TypeError("questions must be a non-empty array");
  for (const question of questions) {
    if (!question || !Array.isArray(question.options)) throw new TypeError("each question must have an options array");
  }
}

/**
 * Create model-owned questionnaire state without terminal or input-control state.
 * @param {Array<object>} questions Non-empty question descriptors, each with an options array.
 * @returns {{questions: Array<object>, index: number, answers: Array, drafts: Array, selections: Array, caret: number, selection: null}} Initial state at question zero.
 * @throws {TypeError} If questions is empty, not an array, or contains a question without an options array.
 */
export function createQuestionnaire(questions) {
  validateQuestions(questions);
  return { questions, index: 0, answers: [], drafts: [], selections: [], caret: 0, selection: null };
}

/**
 * Return the descriptor currently presented by the application.
 * @param {object} state Questionnaire model state.
 * @returns {object|undefined} Descriptor at state.index, or undefined when the index is out of range.
 */
export function currentQuestion(state) {
  return state.questions[state.index];
}

/**
 * Move to a valid question index, retaining any unsubmitted custom draft.
 * @param {object} state Questionnaire model state.
 * @param {number} index Requested destination index; invalid values leave state unchanged.
 * @param {string} [draft] Current question's draft to retain when it is a string.
 * @returns {object} Updated state, or the original state for an invalid index.
 */
export function moveQuestion(state, index, draft) {
  if (!Number.isInteger(index) || index < 0 || index >= state.questions.length) return state;
  const drafts = [...state.drafts];
  if (typeof draft === "string") drafts[state.index] = draft;
  return { ...state, index, drafts };
}

/**
 * Get current checkbox-style selections for the active question.
 * @param {object} state Questionnaire model state.
 * @returns {Array} A copy of active selections, falling back to labels in its recorded answer and then an empty array.
 */
export function selectedLabels(state) {
  return [...(state.selections?.[state.index] ?? state.answers[state.index]?.labels ?? [])];
}

/**
 * Toggle one valid label without coupling questionnaire state to menu geometry.
 * @param {object} state Questionnaire model state.
 * @param {*} label Option label to toggle.
 * @returns {object} Updated state, or the original state if label is not among the current question's options.
 * @throws {TypeError} If state does not provide a current question with an options array.
 */
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

/**
 * Record selected labels after validating them against the descriptor.
 * @param {object} state Questionnaire model state.
 * @param {Iterable} labels Candidate option labels; duplicates and unknown labels are discarded.
 * @returns {{state: object, complete: boolean, answers?: Array}} Result with updated model; answers is included when all questions are complete.
 * @throws {TypeError} If labels is not iterable or the current question has no options array.
 */
export function answerWithLabels(state, labels) {
  const question = currentQuestion(state);
  const allowed = new Set(question.options.map((option) => option.label));
  const selected = [...new Set(labels)].filter((label) => allowed.has(label));
  const answer = question.multiSelect === true ? selected : selected.slice(0, 1);
  if (answer.length === 0) return { state, complete: false };
  return recordAnswer(state, { labels: answer });
}

/**
 * Record typed text. On multi-select it augments the checked labels.
 * @param {object} state Questionnaire model state.
 * @param {*} text Value converted to a string for the answer.
 * @returns {{state: object, complete: boolean, answers?: Array}} Result with updated model; answers is included when all questions are complete.
 * @throws {TypeError} If text conversion fails or state has no current question.
 */
export function answerWithText(state, text) {
  const value = String(text);
  const labels = currentQuestion(state).multiSelect === true ? selectedLabels(state) : [];
  return recordAnswer(state, labels.length > 0 ? { labels, text: value } : { text: value });
}

/**
 * Abandon the current and every later unanswered question.
 * @param {object} state Questionnaire model state.
 * @returns {{state: object, complete: true, answers: Array}} Completed result with unanswered current/later entries marked abandoned.
 */
export function abandonQuestions(state) {
  const answers = [...state.answers];
  for (let index = state.index; index < state.questions.length; index++) {
    if (answers[index] === undefined) answers[index] = { abandoned: true };
  }
  return { state: { ...state, answers }, complete: true, answers };
}

/**
 * Store an answer, clear its draft, update its selections, and advance to the next unanswered question.
 * @param {object} state Questionnaire model state.
 * @param {object} answer Answer record for the active question.
 * @returns {{state: object, complete: boolean, answers?: Array}} Updated model and completion status; includes answers when complete.
 */
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
