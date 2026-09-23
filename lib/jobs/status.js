import { readFile } from "node:fs/promises";
import { jobsPaths } from "./paths.js";
import { canonicalProjectRoot } from "./project.js";
import { validateJobsOperational, readTaskEntries } from "./operations.js";
import { parseTasks } from "./tasks.js";
import { loadAllTaskStates, projectOccurrence } from "./state.js";

function diagnostic(error) { return { code: error.code ?? "JOBS_STATUS_READ", message: error.code?.startsWith("JOBS_") ? error.message : "jobs status data cannot be read" }; }
/** Read-only status projection. It never creates folders, starts daemons, or coordinates processes. */
export async function jobsStatus(projectRoot, options = {}) {
  const root = await canonicalProjectRoot(projectRoot), diagnostics = [], now = (options.clock ?? Date.now)();
  const result = { eligibility: { state: "absent" }, defaults: options.defaults ?? {}, due: [], next: [], running: [], outcomes: [], diagnostics };
  try { await validateJobsOperational(root, options); result.eligibility = { state: "enabled" }; }
  catch (error) { result.eligibility.state = error.code === "JOBS_DISABLED" ? "disabled" : error.code === "JOBS_INACTIVE" ? "absent" : error.code === "JOBS_COLLISION" ? "collision" : "damaged"; if (result.eligibility.state === "damaged") diagnostics.push(diagnostic(error)); }
  if (result.eligibility.state !== "enabled") return result;
  let states = [];
  try { states = await loadAllTaskStates(root); } catch (error) { diagnostics.push(diagnostic(error)); }
  for (const state of states) for (const occurrence of state.occurrences) for (const attempt of occurrence.attempts) { const row = { id: state.taskId, occurrence: occurrence.id, attempt: attempt.id, outcome: attempt.outcome, session: attempt.session, unconfirmed: attempt.unconfirmed }; if (attempt.outcome === "prepared") result.running.push({ ...row, live: "unknown" }); else result.outcomes.push(row); }
  try { const loaded = await readTaskEntries(root), parsed = parseTasks(loaded.entries); diagnostics.push(...loaded.diagnostics, ...parsed.diagnostics); result.tasks = parsed.tasks.map((task) => ({ id: task.id, filename: task.filename, enabled: task.enabled, schedule: task.schedule, model: task.model ?? result.defaults.model ?? null, timeout: task.timeout ?? result.defaults.timeout ?? null, tools: task.tools ?? result.defaults.tools ?? "*" })); for (const task of parsed.tasks) { const scheduledAt = projectOccurrence(states.find((state) => state.taskId === task.id), task, now); if (scheduledAt === null) continue; const projection = { id: task.id, scheduledAt }; if (scheduledAt <= now) result.due.push(projection); else result.next.push(projection); } } catch (error) { diagnostics.push(diagnostic(error)); }
  try { result.lastRun = JSON.parse(await readFile(jobsPaths(root).lastRun, "utf8")); } catch (error) { if (error.code !== "ENOENT") diagnostics.push(diagnostic(error)); }
  return result;
}
