/** Coded jobs-domain error shared by validation, scheduling and execution. */
export class JobsError extends Error {
  /** Construct a coded domain failure; details carry context such as the task filename or the underlying cause. */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "JobsError";
    this.code = code;
    this.details = details;
  }
}
