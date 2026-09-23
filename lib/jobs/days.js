/** Shared task-calendar day grammar; canonical values use Date numbering (Sunday 0). */
import { JobsError } from "./errors-base.js";

/** Immutable task-calendar all-days filter; Sunday 0 through Saturday 6. */
export const ALL_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
const DAY_NAMES = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });

/** Normalize aliases or unique lowercase named arrays; omitted input means all days. */
export function normalizeDays(value, code = "JOBS_TASK_SCHEDULE") {
  if (value === undefined) return ALL_DAYS;
  if (value === "weekdays") return Object.freeze([1, 2, 3, 4, 5]);
  if (value === "weekends") return Object.freeze([0, 6]);
  if (!Array.isArray(value) || value.length === 0) throw new JobsError(code, "days must be weekdays, weekends, or a non-empty array of day names");
  const selected = new Set();
  for (const day of value) {
    if (typeof day !== "string" || !Object.hasOwn(DAY_NAMES, day) || selected.has(DAY_NAMES[day])) throw new JobsError(code, "days must contain unique canonical day names");
    selected.add(DAY_NAMES[day]);
  }
  return Object.freeze([...selected].sort((left, right) => left - right));
}
