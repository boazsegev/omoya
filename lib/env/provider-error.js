/** Provider/transport error with a stable failure class. */
export class ProviderError extends Error {
  /** Build a stable classified provider error.
   * @param {"auth"|"network"|"provider"|"malformed"} kind
   * @param {string} message
   * @param {object} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    Object.assign(this, detail);
  }
}
