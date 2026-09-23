/** Coded jobs-domain error shared by validation, scheduling and execution. */
export class JobsError extends Error {
  /** Construct a coded domain failure; details are caller diagnostics, not safe-to-log source. */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "JobsError";
    this.code = code;
    this.details = details;
  }
}
