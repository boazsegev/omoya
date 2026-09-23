import { JobsError } from "./errors-base.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Refuse excessive catch-up atomically; never silently truncate durable history. */
export const CALENDAR_DAY_LIMIT = 3660;
export const OCCURRENCE_ADMISSION_LIMIT = 10_000;

function limit(message) { throw new JobsError("JOBS_ADMISSION_LIMIT", message); }
function dateParts(epoch, timeZone) {
  const date = new Date(epoch), prefix = timeZone === "gmt" ? "getUTC" : "get";
  return [date[`${prefix}FullYear`](), date[`${prefix}Month`](), date[`${prefix}Date`]()];
}
function dayNumber(epoch, timeZone) { return Math.floor(Date.UTC(...dateParts(epoch, timeZone)) / DAY_MS); }
function civilEpoch(day, minute, timeZone) {
  const label = new Date(day * DAY_MS);
  if (timeZone === "gmt") return day * DAY_MS + minute * MINUTE_MS;
  const date = new Date(label.getUTCFullYear(), label.getUTCMonth(), label.getUTCDate(), Math.floor(minute / 60), minute % 60);
  // Date chooses the first instant of a fold. Round-trip rejects DST gaps and skipped dates.
  const matches = date.getFullYear() === label.getUTCFullYear() && date.getMonth() === label.getUTCMonth() && date.getDate() === label.getUTCDate() && date.getHours() * 60 + date.getMinutes() === minute;
  return matches ? date.getTime() : null;
}
/** Start a fresh calendar cursor at the current civil day, allowing today's missed times. */
export function calendarDayStart(schedule, epoch) {
  const [year, month, day] = dateParts(epoch, schedule.timeZone);
  return Math.max(0, schedule.timeZone === "gmt" ? Date.UTC(year, month, day) : new Date(year, month, day).getTime());
}
/** Check a scheduled instant's weekday in the schedule's own clock basis. */
export function scheduleAllowsDay(schedule, epoch) {
  if (!schedule.days) return true;
  const date = new Date(epoch);
  return schedule.days.includes(schedule.timeZone === "gmt" ? date.getUTCDay() : date.getDay());
}
/** Enumerate selected civil times, not elapsed minutes; callers supply an inclusive epoch window. */
export function calendarOccurrences(schedule, from, through) {
  if (through < from) return [];
  const first = dayNumber(from, schedule.timeZone), last = dayNumber(through, schedule.timeZone);
  if (last - first + 1 > CALENDAR_DAY_LIMIT) limit(`calendar catch-up exceeds ${CALENDAR_DAY_LIMIT} civil days; edit the schedule to reset admission`);
  const result = [];
  for (let day = first; day <= last; day++) {
    if (!schedule.days.includes(new Date(day * DAY_MS).getUTCDay())) continue;
    for (const minute of schedule.minutes) {
      const epoch = civilEpoch(day, minute, schedule.timeZone);
      if (epoch === null || epoch < from || epoch > through) continue;
      if (result.length >= OCCURRENCE_ADMISSION_LIMIT) limit(`catch-up exceeds ${OCCURRENCE_ADMISSION_LIMIT} occurrences; edit the schedule to reset admission`);
      result.push(epoch);
    }
  }
  return result.sort((left, right) => left - right);
}
/** Return the first selected civil instant strictly after epoch, respecting DST gaps. */
export function nextCalendarOccurrence(schedule, epoch) {
  const first = dayNumber(epoch, schedule.timeZone), last = first + CALENDAR_DAY_LIMIT - 1;
  for (let day = first; day <= last; day++) {
    if (!schedule.days.includes(new Date(day * DAY_MS).getUTCDay())) continue;
    for (const minute of schedule.minutes) {
      const candidate = civilEpoch(day, minute, schedule.timeZone);
      if (candidate !== null && candidate > epoch) return candidate;
    }
  }
  limit(`calendar search exceeds ${CALENDAR_DAY_LIMIT} civil days`);
}
/** Enforce an explicit bound before enumerating an elapsed recurrence gap. */
export function checkOccurrenceCount(count) {
  if (count > OCCURRENCE_ADMISSION_LIMIT) limit(`catch-up exceeds ${OCCURRENCE_ADMISSION_LIMIT} occurrences; edit the schedule to reset admission`);
}
