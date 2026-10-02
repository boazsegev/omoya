/** Coded jobs-domain error shared by validation, scheduling and execution. */
export class JobsError extends Error {
  /**
   * Create a coded jobs-domain error.
   * @param {string} code - Stable error code identifying the failure.
   * @param {string} message - Human-readable error message passed to `Error`.
   * @param {object} [details={}] - Optional contextual data, such as a task filename or underlying cause.
   * @returns {JobsError} The initialized error instance.
   * @throws Any exception raised while the native `Error` constructor converts the supplied message.
   * @effects Initializes the native error state and sets `name`, `code`, and `details` on the instance.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "JobsError";
    this.code = code;
    this.details = details;
  }
}
