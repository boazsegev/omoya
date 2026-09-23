import { describe, expect, test } from "bun:test";
import { admitOccurrence, createTaskState, validateTaskState } from "../lib/jobs.js";
import { CALENDAR_DAY_LIMIT, OCCURRENCE_ADMISSION_LIMIT } from "../lib/jobs/calendar.js";

const epoch = (value) => Date.parse(value);
function at(minutes = [540], days = [0, 1, 2, 3, 4, 5, 6], timeZone = "gmt") {
  return { id: "calendar", enabled: true, schedule: { kind: "at", minutes, days, timeZone } };
}
function admit(task, now, state = createTaskState(task)) { return admitOccurrence(state, task, epoch(now)); }

describe("calendar occurrence admission", () => {
  test("starts with today's missed times only and waits for future times", () => {
    const task = at([540, 780]);
    const morning = admit(task, "2026-09-14T08:00:00Z");
    expect(morning.due).toBeNull(); expect(morning.changed).toBeTrue();
    expect(validateTaskState(morning.state)).toEqual(morning.state);
    const noon = admit(task, "2026-09-14T12:00:00Z", morning.state);
    expect(noon.due.scheduledAt).toBe(epoch("2026-09-14T09:00:00Z"));
    const evening = admit(task, "2026-09-14T14:00:00Z", noon.state);
    expect(evening.due.scheduledAt).toBe(epoch("2026-09-14T13:00:00Z"));
    expect(evening.state.occurrences.map((item) => item.status)).toEqual(["coalesced", "due"]);
    expect(admit(task, "2026-09-14T08:00:00Z", evening.state).due).toBeNull();
    expect(admit(task, "2026-09-14T14:00:00Z", evening.state).due).toBeNull();
  });
  test("coalesces eligible multi-day gaps in epoch order and honors weekday lists", () => {
    const task = at([540, 780], [1, 3, 5]);
    const start = admit(task, "2026-09-11T08:00:00Z");
    const result = admit(task, "2026-09-16T14:00:00Z", start.state);
    expect(result.state.occurrences.map((item) => new Date(item.scheduledAt).toISOString())).toEqual([
      "2026-09-11T09:00:00.000Z", "2026-09-11T13:00:00.000Z", "2026-09-14T09:00:00.000Z", "2026-09-14T13:00:00.000Z", "2026-09-16T09:00:00.000Z", "2026-09-16T13:00:00.000Z",
    ]);
    expect(result.state.occurrences.filter((item) => item.status === "due")).toHaveLength(1);
    expect(admit(at([540], [0, 6]), "2026-09-14T10:00:00Z").due).toBeNull();
    expect(admit(at([540], [0, 6]), "2026-09-13T10:00:00Z").due.scheduledAt).toBe(epoch("2026-09-13T09:00:00Z"));
  });
  test("preserves disabled history and phase; schedule-only edits reset on enabled admission", () => {
    const task = at(); const first = admit(task, "2026-09-14T10:00:00Z");
    const disabled = admit({ ...task, enabled: false }, "2026-09-16T10:00:00Z", first.state);
    expect(disabled.state).toEqual(first.state); expect(disabled.changed).toBeFalse();
    const resumed = admit({ ...task, prompt: "edited", timeout: 10 }, "2026-09-16T10:00:00Z", disabled.state);
    expect(resumed.state.anchor).toBe(first.state.anchor); expect(resumed.state.occurrences).toHaveLength(3);
    for (const changedTask of [at([600]), at([540], [1, 2, 3]), at([540], undefined, "local")]) {
      const changed = admit(changedTask, "2026-09-17T08:00:00Z", resumed.state);
      expect(changed.state.schedule).toEqual(changedTask.schedule);
      expect(changed.state.anchor).not.toBe(first.state.anchor);
      expect(changed.state.occurrences.slice(0, 3).map((item) => item.id)).toEqual(resumed.state.occurrences.map((item) => item.id));
    }
    const resetSameEpoch = admit(at([540, 600]), "2026-09-14T09:00:00Z", first.state);
    expect(resetSameEpoch.due).toBeNull(); expect(validateTaskState(resetSameEpoch.state)).toEqual(resetSameEpoch.state);
  });
  test("rejects corrupt calendar snapshot, cursor, versions and out-of-range epochs", () => {
    const state = admit(at(), "2026-09-14T10:00:00Z").state;
    const invalid = [
      { ...state, version: 1 }, { ...state, cursor: state.anchor - 1 }, { ...state, cursor: state.cursor + 1 }, { ...state, anchor: null },
      ...[{ kind: "at", minutes: [1, 1], days: [1], timeZone: "gmt" }, { kind: "at", minutes: [1440], days: [1], timeZone: "gmt" }, { ...state.schedule, days: [] }, { ...state.schedule, days: [7] }, { ...state.schedule, timeZone: "UTC" }, { ...state.schedule, ignored: true }].map((schedule) => ({ ...state, schedule })),
      { ...state, anchor: Number.MAX_SAFE_INTEGER },
    ];
    for (const value of invalid) expect(() => validateTaskState(value)).toThrow();
  });
  test("refuses excessive catch-up atomically with documented bounds", () => {
    const task = at(); const start = admit(task, "2000-01-01T00:00:00Z");
    expect(() => admitOccurrence(start.state, task, epoch("2000-01-01T00:00:00Z") + CALENDAR_DAY_LIMIT * 86400000)).toThrow("civil days");
    const every = { id: "elapsed", enabled: true, schedule: { kind: "every", milliseconds: 1 } };
    const elapsed = admitOccurrence(createTaskState(every), every, 0);
    expect(() => admitOccurrence(elapsed.state, every, OCCURRENCE_ADMISSION_LIMIT + 1)).toThrow("occurrences");
    expect(elapsed.state.cursor).toBe(0); expect(start.state.cursor).toBeNull();
  });
});

describe("isolated local timezone semantics", () => {
  function inZone(zone, source) {
    const script = `import { admitOccurrence, createTaskState } from './lib/jobs/state.js';\nconst admit = (task, now, state = createTaskState(task)) => admitOccurrence(state, task, Date.parse(now));\n${source}`;
    const result = Bun.spawnSync(["bun", "--eval", script], { cwd: process.cwd(), env: { ...process.env, TZ: zone } });
    expect(result.exitCode).toBe(0); return JSON.parse(result.stdout.toString());
  }
  test("skips nonexistent local civil times and chooses the first occurrence of a fold", () => {
    const gap = inZone("America/New_York", `const task = ${JSON.stringify(at([150], undefined, "local"))}; const start = admit(task, '2026-03-07T00:00:00-05:00'); const end = admit(task, '2026-03-09T04:00:00-04:00', start.state); process.stdout.write(JSON.stringify(end.state.occurrences.map(x => new Date(x.scheduledAt).toISOString())));`);
    expect(gap).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    const fold = inZone("America/New_York", `const task = ${JSON.stringify(at([90], undefined, "local"))}; const first = admit(task, '2026-11-01T01:45:00-04:00'); const second = admit(task, '2026-11-01T01:45:00-05:00', first.state); process.stdout.write(JSON.stringify({times: second.state.occurrences.map(x => new Date(x.scheduledAt).toISOString()), due: second.due}));`);
    expect(fold).toEqual({ times: ["2026-11-01T05:30:00.000Z"], due: null });
  });
  test("uses UTC weekdays and epochs for GMT, while local follows the host timezone", () => {
    const source = (task) => `const task = ${JSON.stringify(task)}; const result = admit(task, '2026-09-14T01:00:00Z'); process.stdout.write(JSON.stringify(result.state));`;
    expect(inZone("America/Los_Angeles", source(at([30], [1])))).toEqual(inZone("Asia/Tokyo", source(at([30], [1]))));
    const local = source(at([30], [1], "local"));
    expect(inZone("America/Los_Angeles", local).occurrences).toHaveLength(0);
    expect(inZone("Asia/Tokyo", local).occurrences[0].scheduledAt).toBe(epoch("2026-09-13T15:30:00Z"));
  });
  test("persisted GMT stays deterministic across timezone movement while local follows the destination", () => {
    for (const basis of ["gmt", "local"]) {
      const task = at([540], undefined, basis);
      const initial = inZone("America/New_York", `const task = ${JSON.stringify(task)}; process.stdout.write(JSON.stringify(admit(task, '2026-09-14T15:00:00Z').state));`);
      const resume = `const task = ${JSON.stringify(task)}; const result = admit(task, '2026-09-15T18:00:00Z', ${JSON.stringify(initial)}); process.stdout.write(JSON.stringify(result));`;
      const tokyo = inZone("Asia/Tokyo", resume), newYork = inZone("America/New_York", resume);
      if (basis === "gmt") expect(tokyo).toEqual(newYork);
      else {
        expect(tokyo.due.scheduledAt).toBe(epoch("2026-09-15T00:00:00Z"));
        expect(newYork.due.scheduledAt).toBe(epoch("2026-09-15T13:00:00Z"));
      }
      expect(tokyo.state.occurrences[0]).toEqual(initial.occurrences[0].status === "due" ? { ...initial.occurrences[0], status: "coalesced" } : initial.occurrences[0]);
    }
  });
  test("elapsed catch-up filters the latest ordinal rather than substituting stale Friday work", () => {
    const task = { id: "elapsed", enabled: true, schedule: { kind: "every", milliseconds: 3600000, days: [1, 2, 3, 4, 5], timeZone: "local" } };
    const result = inZone("America/New_York", `const task = ${JSON.stringify(task)}; const fri = admit(task, '2026-09-11T22:30:00-04:00'); const early = admit(task, '2026-09-14T00:10:00-04:00', fri.state); const later = admit(task, '2026-09-14T00:40:00-04:00', early.state); process.stdout.write(JSON.stringify({early, later}));`);
    expect(result.early.due).toBeNull();
    expect(result.early.state.occurrences.every((item) => item.status === "coalesced")).toBeTrue();
    expect(result.later.due.scheduledAt).toBe(epoch("2026-09-14T00:30:00-04:00"));
    expect(result.later.state.anchor).toBe(epoch("2026-09-11T22:30:00-04:00"));
  });
  test("day-filtered every coalesces excluded days without shifting elapsed phase", () => {
    const task = { id: "elapsed", enabled: true, schedule: { kind: "every", milliseconds: 3600000, days: [1, 2, 3, 4, 5], timeZone: "local" } };
    const result = inZone("America/New_York", `const task = ${JSON.stringify(task)}; const fri = admit(task, '2026-03-06T23:30:00-05:00'); const sun = admit(task, '2026-03-08T23:45:00-04:00', fri.state); const mon = admit(task, '2026-03-09T00:45:00-04:00', sun.state); process.stdout.write(JSON.stringify({fri: fri.state.anchor, sunday: sun.due, due: mon.due, state: mon.state}));`);
    expect(result.sunday).toBeNull(); expect(result.state.anchor).toBe(result.fri);
    expect(result.due.scheduledAt).toBe(epoch("2026-03-09T00:30:00-04:00"));
    expect((result.due.scheduledAt - result.fri) % 3600000).toBe(0);
    expect(result.state.occurrences.filter((item) => item.status === "due")).toHaveLength(1);
    expect(result.state.occurrences).toHaveLength(49);
  });
});
