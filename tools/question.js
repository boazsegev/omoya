/**
 * tools/question.js — the `question` tool: ask the user one or more
 * structured questions mid-task (pi question-tool semantics): 1–4
 * questions, each with a ≤16-character header chip, 2–16 options
 * (label ≤60 characters + description, optional preview), and an
 * optional multiSelect flag. The engine appends its own free-text
 * affordance (pi's "Type something." row) — it is NOT an option here.
 *
 * DISENTANGLED from the rendering engine: the tool owns argument
 * validation and answer normalization; the harness's QUESTION BRIDGE
 * (context.question.ask — provided by the Agent, which received it
 * from the TUI/HTML/WebSocket binding) owns rendering the questions
 * and previews and collecting the answers. The bridge is the
 * INTERNAL second argument, never part of the published schema.
 * Bridge answer shape, one per question:
 *   { labels: string[] }  — the chosen option label(s)
 *   { text: string }      — a custom typed answer
 *   { abandoned: true }   — the user pressed Esc
 * Without a bridge the tool REFUSES (throws): a session with no one
 * to ask cannot ask — CLI bindings wire the bridge ONLY into the
 * ACTIVE agent (the one being displayed), so a session running
 * headless execution has no question handler and every
 * question is refused. The refusal text tells the model to proceed
 * with its best judgment instead.
 *
 * Read-only (safe: true): asking the user mutates nothing — safe-mode
 * Agents may ask questions. The forked, OS-sandboxed worker uses the
 * Agent's typed fd-3/fd-4 JSONL ask/answer bridge; no host callback crosses
 * the sandbox.
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 16;
const MIN_OPTIONS = 2;
const MAX_HEADER = 16;
const MAX_LABEL = 60;

/** Validate and normalize the questions argument (pi semantics). */
function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_QUESTIONS) {
    throw new TypeError(`Provide an array of 1-${MAX_QUESTIONS} questions, then try again.`);
  }
  return input.map((q, i) => {
    const where = `question ${i + 1}`;
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      throw new TypeError(`Fix ${where}: provide an object with question, header, and options.`);
    }
    const text = String(q.question ?? "").trim();
    if (text === "") throw new TypeError(`Fix ${where}: provide non-empty question text.`);
    const header = String(q.header ?? "").trim();
    if (header === "" || header.length > MAX_HEADER) {
      throw new TypeError(`Fix ${where}: provide a header of 1-${MAX_HEADER} characters.`);
    }
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      throw new TypeError(`Fix ${where}: provide ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
    }
    const options = q.options.map((o, k) => {
      const at = `${where} option ${k + 1}`;
      const label = String(o?.label ?? "").trim();
      if (label === "" || label.length > MAX_LABEL) {
        throw new TypeError(`Fix ${at}: provide a label of 1-${MAX_LABEL} characters.`);
      }
      const description = String(o?.description ?? "").trim();
      if (description === "") throw new TypeError(`Fix ${at}: provide a description.`);
      let preview;
      if (typeof o?.preview === "string") preview = o.preview;
      else if (o?.preview && typeof o.preview === "object" && !Array.isArray(o.preview)) {
        const type = o.preview.type === "code" ? "code" : "text";
        const content = String(o.preview.content ?? "");
        if (content !== "") preview = {
          type, content,
          ...(o.preview.language ? { language: String(o.preview.language) } : {}),
          ...(o.preview.title ? { title: String(o.preview.title) } : {}),
        };
      }
      return { label, description, ...(preview === undefined ? {} : { preview }) };
    });
    return {
      question: text,
      header,
      ...(q.details === undefined ? {} : { details: String(q.details) }),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    };
  });
}

/** One answer to text (the model-facing normalization). */
function answerText(answer) {
  if (answer === null || typeof answer !== "object") return "(no answer)";
  if (answer.abandoned === true) return "(the user abandoned the question — no answer)";
  if (Array.isArray(answer.labels) && answer.labels.length > 0) return answer.labels.map(String).join(", ");
  if (typeof answer.text === "string" && answer.text.trim() !== "") return answer.text.trim();
  return "(no answer)";
}

/**
 * Ask the user one or more structured questions.
 * @param {Object} args
 * @param {Array} args.questions - 1-4 questions, each with 2-16 options
 * @param {Object} [context] - harness tool context ({question: {ask}})
 * @returns {Promise<string>} the questions with their answers
 */
export async function question({ questions } = {}, context) {
  const list = normalizeQuestions(questions);
  const bridge = typeof context?.question?.ask === "function" ? context.question.ask : null;
  if (bridge === null) {
    throw new Error(
      "Proceed using your best judgment within available permissions; no user is available to answer questions right now.",
    );
  }
  const answers = await bridge(list);
  if (answers === null) {
    throw new Error(
      "Proceed using your best judgment within your instructions and permissions; the user cannot answer questions right now.",
    );
  }
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    lines.push(`Q${list.length > 1 ? ` ${i + 1}` : ""}: ${list[i].question}`);
    lines.push(`A: ${answerText(answers?.[i])}`);
  }
  return lines.join("\n");
}

export function toolDescription() {
  return {
    question: {
      safe: true, // read-only: asking the user mutates nothing
      sandbox: true, // fd-3/fd-4 JSONL question bridge inside the OS sandbox
      description: "Ask structured user questions with selectable options and custom answers.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "Questions to ask the user (1-4 questions)",
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "The complete question to ask the user. Clear, specific, ending with a question mark.",
                },
                header: {
                  type: "string",
                  description: "Very short chip/tag shown next to the question (max 16 characters).",
                },
                details: {
                  type: "string",
                  description: "Optional supporting context, constraints, or consequences shown under the question.",
                },
                multiSelect: {
                  type: "boolean",
                  description: "Allow selecting multiple options instead of just one.",
                },
                options: {
                  type: "array",
                  description: "The available choices (2-16 options).",
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "The display text for this option (max 60 characters).",
                      },
                      description: {
                        type: "string",
                        description: "What this option means or what happens if chosen.",
                      },
                      preview: {
                        description: "Optional focused preview: a plain string, or typed text/code with optional title and language.",
                        oneOf: [
                          { type: "string" },
                          {
                            type: "object",
                            properties: {
                              type: { type: "string", enum: ["text", "code"] },
                              content: { type: "string" },
                              language: { type: "string" },
                              title: { type: "string" },
                            },
                            required: ["type", "content"],
                          },
                        ],
                      },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  };
}
