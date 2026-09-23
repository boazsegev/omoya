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
 * Is this a core-shaped message (a numeric `type` and a `content` array)?
 * @param {*} msg
 * @returns {boolean} true when msg has the core message shape
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
 * Is this a metadata RECORD (a string `type`, never a numeric message
 * type)? Records are harness/tool-owned data entries that may share
 * the context array and the session file with messages (the note
 * tool's compaction-surviving store backup is the first). A record
 * is NEVER a message: validators skip it, appendMessage passes it
 * through unmerged, IO filters it from every provider-bound
 * context, and the session file's own `session-metadata` header
 * record is the loader's one exclusion (it maps the file, it is not
 * context content).
 * @param {*} msg
 * @returns {boolean} true when msg carries a string `type`
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
 * Is this a context (an array of core-shaped messages and/or records)?
 * @param {*} ctx
 * @returns {boolean} true when ctx is an array of messages/records
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
 * @param {*} msg
 * @returns {boolean}
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
 * Validate a message's CORE SHAPE, throwing on a violation.
 * Returns the SAME object reference — metadata is never copied,
 * stripped, or reordered. Emptiness is deliberately NOT part of the
 * shape: appendMessage REFUSES (drops) an empty incoming message,
 * and IO DROPS empty messages from every provider-bound context
 * (no dialect can carry one), while a merge that consumed an
 * incoming message's whole payload into the previous message may
 * legitimately leave it empty inside the live array.
 * @param {*} msg
 * @param {string} [at] - address hint for error messages (e.g. "context[2]")
 * @returns {object} msg, unchanged
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
 * Validate a context array. Returns the same array reference.
 * @param {*} ctx
 * @returns {Array} ctx, unchanged
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

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
