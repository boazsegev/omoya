/**
 * lib/validate.js — tolerant-reader validators for the context format.
 *
 * Only the core shape is checked: a message needs a numeric `type` and a
 * `content` array. Everything else is metadata and passes through
 * untouched — unknown fields never invalidate a value, and there is no
 * provider-shape validation by design (providers change independently of
 * core; validating them here would couple core to provider schemas).
 */

/**
 * Test whether a value has the core message shape: a non-array object with
 * a numeric `type` and an array `content`.
 * @param {*} msg - Value to test.
 * @returns {boolean} True when `msg` has the core message shape.
 */
export function isMessage(msg) {
  return (
    msg !== null &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    typeof msg.type === "number" &&
    Array.isArray(msg.content)
  );
}

/**
 * Test whether a value is a metadata record: a non-array object with a
 * string `type` (not a numeric message type). Records may share context and
 * session files with messages; they are not messages and are skipped by
 * message validators. Other components pass them through unmerged or filter
 * them from provider-bound contexts as appropriate.
 * @param {*} msg - Value to test.
 * @returns {boolean} True when `msg` carries a string `type`.
 */
export function isRecord(msg) {
  return (
    msg !== null &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    typeof msg.type === "string"
  );
}

/**
 * Test whether a value is a context array containing only core-shaped
 * messages and/or metadata records.
 * @param {*} ctx - Value to test.
 * @returns {boolean} True when `ctx` is such an array; an empty array passes.
 */
export function isContext(ctx) {
  return Array.isArray(ctx) && ctx.every((m) => isMessage(m) || isRecord(m));
}

/**
 * Has this message any CONTENT a provider can consume? A block with
 * no payload — a text/thinking block whose text is empty, a block
 * reduced to its discriminator alone — is not content; an empty
 * content array is not content either. Chat-completions dialects
 * serialize an empty assistant message as `content: null` and
 * providers 400 the whole request over it (corrupted sessions), so
 * emptiness is a hard contract, not a style point.
 * @param {*} msg - Value whose `content` blocks are inspected.
 * @returns {boolean} True if at least one block carries provider-consumable content.
 */
export function hasContent(msg) {
  return Array.isArray(msg?.content) && msg.content.some((block) => {
    if (block === null || typeof block !== "object") return false;
    // a text/thinking block carries its payload in `text`; every
    // other block kind (toolCall, image, binary, unknown tolerated
    // types) is content by its fields alone — a text-kind check would
    // misread a tool call's empty argument string
    if (block.type === "text" || block.type === "thinking") {
      return typeof block.text === "string" && block.text !== "";
    }
    return true;
  });
}

/**
 * Does this message report a FAILED RESPONSE? A provider or transport
 * failure is normalized as the response message carrying `error` — a
 * text string or {message, retry} for timed rate limits — beside whatever content arrived before it (possibly
 * none: the error is then its whole payload). A tool result's boolean
 * `error: true` is not one: that is the tool's own (answered) failure.
 * @param {*} msg - Value whose normalized response error is inspected.
 * @returns {boolean} True for a nonempty error string or nonempty `error.message`.
 */
export function hasError(msg) {
  return (typeof msg?.error === "string" && msg.error !== "") ||
    (typeof msg?.error?.message === "string" && msg.error.message !== "");
}

/**
 * Get the presentation text of a normalized assistant failure; tool-result
 * boolean errors are distinct and produce an empty string.
 * @param {*} msg - Value whose error field is inspected.
 * @returns {string} The error string, `error.message`, or an empty string.
 */
export function errorText(msg) {
  return typeof msg?.error === "string" ? msg.error : msg?.error?.message ?? "";
}

/**
 * Validate a message's CORE SHAPE, throwing on a violation.
 * Returns the SAME object reference — metadata is never copied,
 * stripped, or reordered. Emptiness is deliberately NOT part of the
 * shape: appendMessage REFUSES (drops) an empty incoming message,
 * and IO DROPS empty messages from every provider-bound context
 * (no dialect can carry one), while a merge that consumed an
 * incoming message's whole payload into the previous message may
 * legitimately leave it empty inside the live array.
 * @param {*} msg - Value to validate.
 * @param {string} [at="message"] - Address hint for error messages (e.g. "context[2]").
 * @returns {object} The same `msg` reference, unchanged.
 * @throws {TypeError} If `msg` is not a non-array object with a numeric `type`
 *   and array `content`; the error includes the address hint.
 */
export function validateMessage(msg, at = "message") {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    throw new TypeError(`${at}: expected a message object, got ${describe(msg)}`);
  }
  if (typeof msg.type !== "number") {
    throw new TypeError(`${at}: missing numeric "type", got ${describe(msg.type)}`);
  }
  if (!Array.isArray(msg.content)) {
    throw new TypeError(`${at}: missing "content" array, got ${describe(msg.content)}`);
  }
  return msg;
}

/**
 * Validate a context array, allowing metadata records and validating every
 * other entry as a message. Returns the same array reference without mutation.
 * @param {*} ctx - Value to validate as a context.
 * @returns {Array} The same `ctx` array, unchanged.
 * @throws {TypeError} If `ctx` is not an array or any non-record entry fails
 *   message validation; entry errors identify their context index.
 */
export function validateContext(ctx) {
  if (!Array.isArray(ctx)) {
    throw new TypeError(`context: expected an array, got ${describe(ctx)}`);
  }
  // metadata RECORDS (string `type`) are legal context entries — only
  // messages validate (isRecord, validate.js)
  for (let i = 0; i < ctx.length; i++) {
    if (isRecord(ctx[i])) continue;
    validateMessage(ctx[i], `context[${i}]`);
  }
  return ctx;
}

/**
 * Describe a value's basic kind for validation error messages.
 * @param {*} value - Value to describe.
 * @returns {string} `null`, `an array`, or the result of `typeof`.
 */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
