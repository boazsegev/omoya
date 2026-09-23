import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { admitOccurrence, allocateArchive, archiveExists, createTaskState, dispatchJobs, loadTaskState, moveToArchive, newAttemptId, recordAttempt, reconcileAttempt, resolveArchiveReference, saveTaskState, snapshotAndArchive, initializeJobs, validateArchiveReference, validateTaskState } from "../lib/jobs.js";

const roots = []; afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "jobs-state-")); roots.push(path); await initializeJobs(path); return path; }
function recurring(every = 100) { return { id: "report.md", enabled: true, schedule: { kind: "every", milliseconds: every } }; }

describe("jobs occurrence state", () => {
  test("anchors first admission, coalesces gaps, and does not replay on rollback", () => {
    let state = createTaskState(recurring());
    let result = admitOccurrence(state, recurring(), 1_000); state = result.state; expect(result.due.scheduledAt).toBe(1_000);
    result = admitOccurrence(state, recurring(), 1_350); state = result.state; expect(result.due.scheduledAt).toBe(1_300); expect(state.occurrences.map((item) => item.status)).toEqual(["coalesced", "coalesced", "coalesced", "due"]);
    expect(admitOccurrence(state, recurring(), 1_100).due).toBeNull();
  });
  test("preserves disabled phase, resets recurrence changes, and only admits once", () => {
    let state = createTaskState(recurring()); state = admitOccurrence(state, recurring(), 100).state;
    expect(admitOccurrence(state, { ...recurring(), enabled: false }, 400).due).toBeNull();
    expect(admitOccurrence(state, recurring(), 400).due.scheduledAt).toBe(400);
    const changed = admitOccurrence(state, recurring(200), 450); expect(changed.due.scheduledAt).toBe(450); expect(changed.state.anchor).toBe(450);
    let once = admitOccurrence(createTaskState({ id: "once", schedule: { kind: "once" } }), { id: "once", enabled: true, schedule: { kind: "once" } }, 9).state;
    expect(admitOccurrence(once, { id: "once", enabled: true, schedule: { kind: "once" } }, 99).due).toBeNull();
  });
  test("persists attempts before archive and reconciles crash consumption visibly", async () => {
    const project = await root(); let state = admitOccurrence(createTaskState(recurring()), recurring(), 10).state; const occurrence = state.occurrences[0];
    const attemptId = newAttemptId(occurrence); state = recordAttempt(state, occurrence.id, { id: attemptId, archive: "completed/a" }); await saveTaskState(project, state);
    expect((await loadTaskState(project, recurring())).occurrences[0].attempts[0].unconfirmed).toBe(true);
    state = reconcileAttempt(state, occurrence.id, attemptId, true); expect(state.occurrences[0]).toMatchObject({ status: "consumed", attempts: [{ outcome: "interrupted", unconfirmed: false }] });
    expect(admitOccurrence(state, recurring(), 10).due).toBeNull();
  });
  test("rejects every malformed persisted discriminant, nested field, and unsafe recurrence before admission", () => {
    const state = admitOccurrence(createTaskState(recurring()), recurring(), 100).state;
    const invalid = [
      { ...state, schedule: { kind: "every", milliseconds: 0 } },
      { ...state, anchor: 100, cursor: null },
      { ...state, occurrences: [{ ...state.occurrences[0], status: "running" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "", archive: "a", session: null, outcome: "prepared", unconfirmed: true }], status: "attempted" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "a", archive: "a", session: null, outcome: "interrupted", unconfirmed: true }], status: "consumed" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], extra: true }] },
      { ...state, anchor: Number.MAX_SAFE_INTEGER, cursor: 1 },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "a", archive: "/private/archive", session: null, outcome: "prepared", unconfirmed: true }], status: "attempted" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "a", archive: "completed/../escape", session: null, outcome: "prepared", unconfirmed: true }], status: "attempted" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "a", archive: "runs\\escape", session: null, outcome: "prepared", unconfirmed: true }], status: "attempted" }] },
      { ...state, occurrences: [{ ...state.occurrences[0], attempts: [{ id: "a", archive: "state/a", session: null, outcome: "prepared", unconfirmed: true }], status: "attempted" }] },
    ];
    for (const corrupt of invalid) {
      try { admitOccurrence(corrupt, recurring(), 200); throw new Error("corrupt state was admitted"); }
      catch (error) { expect(error.code).toBe("JOBS_STATE_SHAPE"); }
    }
  });
  test("accepts only portable completed/runs archive references", () => {
    let state = admitOccurrence(createTaskState(recurring()), recurring(), 100).state; const occurrence = state.occurrences[0];
    state = recordAttempt(state, occurrence.id, { id: "one", archive: "runs/uuid.snapshot" });
    expect(validateTaskState(state).occurrences[0].attempts[0].archive).toBe("runs/uuid.snapshot");
    for (const ref of ["/private/archive", "C:/archive", "completed/../escape", "runs\\escape", "state/a", "completed/a/b"]) {
      expect(() => validateArchiveReference(ref)).toThrow();
    }
  });
  test("rejects malicious durable references before any archive filesystem access", async () => {
    const project = await root(), task = recurring(); let state = admitOccurrence(createTaskState(task), task, 1).state;
    state = recordAttempt(state, state.occurrences[0].id, { id: "attempt", archive: "runs/safe.snapshot" });
    state.occurrences[0].attempts[0].archive = "../../outside";
    await writeFile(join(project, "ai-jobs/state/report.md.json"), JSON.stringify(state));
    const io = { ...await import("node:fs/promises"), stat: async () => { throw new Error("archive filesystem access occurred"); } };
    await expect(dispatchJobs(project, { io, executor: async () => ({ outcome: "completed" }) })).resolves.toMatchObject({ errors: [{ code: "JOBS_STATE_SHAPE" }] });
  });
  test("prepared and finalized states remain portable after project moves, and reconciliation reads only the moved tree", async () => {
    const parent = await root(), source = join(parent, "source"), moved = join(parent, "moved"); await mkdir(source); await initializeJobs(source);
    const task = recurring(), state0 = admitOccurrence(createTaskState(task), task, 1).state;
    let prepared = recordAttempt(state0, state0.occurrences[0].id, { id: "prepared", archive: "runs/prepared.snapshot" });
    await saveTaskState(source, prepared); await writeFile(resolveArchiveReference(source, "runs/prepared.snapshot"), "snapshot");
    await rename(source, moved); await dispatchJobs(moved, { executor: async () => ({ outcome: "completed" }) });
    expect((await loadTaskState(moved, task)).occurrences[0].attempts[0].outcome).toBe("interrupted");
    const finalized = await loadTaskState(moved, task); expect(JSON.stringify(finalized)).not.toContain(source);
  });
  test("retains attempt history for explicit resubmission and applies non-schedule edits without resetting phase", () => {
    let state = admitOccurrence(createTaskState(recurring()), recurring(), 100).state; const occurrence = state.occurrences[0];
    state = recordAttempt(state, occurrence.id, { id: "first", archive: "completed/first" }); state = reconcileAttempt(state, occurrence.id, "first", false);
    state = recordAttempt(state, occurrence.id, { id: "second", archive: "completed/second", session: "new-session" });
    expect(state.occurrences[0].attempts.map((item) => item.id)).toEqual(["first", "second"]);
    expect(admitOccurrence(state, { ...recurring(), enabled: true, prompt: "edited" }, 200).due.scheduledAt).toBe(200);
  });
});

describe("jobs archive", () => {
  test("allocates local date names beyond 999 and never overwrites collisions", async () => {
    const project = await root(); const completed = join(project, "ai-jobs/completed"); await mkdir(completed, { recursive: true }); await writeFile(join(completed, "2026-01-02 000 a.md"), "a");
    expect(await allocateArchive(project, "2026-01-02", "a.md")).toEndWith("2026-01-02 001 a.md");
    await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(join(completed, `2026-01-02 ${String(index).padStart(3, "0")} used.md`), "x"))); expect(await allocateArchive(project, "2026-01-02", "b.md")).toEndWith("2026-01-02 1000 b.md");
    const source = join(project, "source.md"), archive = join(completed, "2026-01-02 000 a.md"); await writeFile(source, "new"); await expect(moveToArchive(source, archive)).rejects.toMatchObject({ code: "JOBS_ARCHIVE_COLLISION" }); expect(await readFile(source, "utf8")).toBe("new");
  });
  test("executes the pre-move snapshot and leaves archive on post-move crash", async () => {
    const project = await root(); const completed = join(project, "ai-jobs/completed"); await mkdir(completed, { recursive: true }); const source = join(project, "source.md"), archive = join(completed, "2026-01-02 000 source.md"); await writeFile(source, "original");
    expect(await snapshotAndArchive(source, archive)).toBe("original"); expect(await readFile(archive, "utf8")).toBe("original"); expect(await archiveExists(archive)).toBe(true);
  });
  test("injected archive-link failure rejects without yielding a snapshot for execution/composition", async () => {
    const project = await root(); const completed = join(project, "ai-jobs/completed"); await mkdir(completed, { recursive: true }); const source = join(project, "source.md"), archive = join(completed, "2026-01-02 000 source.md"); await writeFile(source, "original");
    let continued = false; const io = { readFile, link: async () => { const error = new Error("full"); error.code = "ENOSPC"; throw error; }, unlink: async () => { continued = true; } };
    await expect(snapshotAndArchive(source, archive, io)).rejects.toMatchObject({ code: "JOBS_ARCHIVE_MOVE" });
    expect(continued).toBeFalse(); expect(await readFile(source, "utf8")).toBe("original");
  });
  test("reports source-unlink discrepancy after a claimed archive and does not continue snapshot composition", async () => {
    const project = await root(); const completed = join(project, "ai-jobs/completed"); await mkdir(completed, { recursive: true }); const source = join(project, "source.md"), archive = join(completed, "2026-01-02 000 source.md"); await writeFile(source, "original");
    const io = { link: async () => writeFile(archive, "original"), unlink: async () => { const error = new Error("denied"); error.code = "EPERM"; throw error; }, readFile, stat: async () => ({}) };
    await expect(snapshotAndArchive(source, archive, io)).rejects.toMatchObject({ code: "JOBS_ARCHIVE_MOVE" });
    expect(await readFile(archive, "utf8")).toBe("original"); expect(await readFile(source, "utf8")).toBe("original");
  });
  test("concurrent allocation collision is claimed without overwrite and a retry allocates another name", async () => {
    const project = await root(); const completed = join(project, "ai-jobs/completed"); await mkdir(completed, { recursive: true }); const source = join(project, "source.md"); await writeFile(source, "new");
    const first = await allocateArchive(project, "2026-01-02", "source.md"); await writeFile(first, "other");
    await expect(moveToArchive(source, first)).rejects.toMatchObject({ code: "JOBS_ARCHIVE_COLLISION" });
    const retry = await allocateArchive(project, "2026-01-02", "source.md"); expect(retry).not.toBe(first); await moveToArchive(source, retry);
    expect(await readFile(first, "utf8")).toBe("other"); expect(await readFile(retry, "utf8")).toBe("new");
  });
});
