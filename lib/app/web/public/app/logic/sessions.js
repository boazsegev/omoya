/** Saved-session list grouping: one group per displayed project. */
import { viewProjects } from "./agents.js";

/** Whether a saved session matches a lowercase filter query (empty matches all). */
export function sessionMatches(item, query) {
  return !query || `${item.id} ${item.agent ?? ""} ${item.preview ?? ""}`.toLowerCase().includes(query);
}

/**
 * Group saved sessions by displayed project, projects sorted alphabetically.
 * The all-projects view displays every served project, a group view its members, a project view only its own.
 * @param {{recent: Array<object>, projects: Array<{name: string, path: string, current?: boolean, groups?: string[]}>, scope: string, group?: string|null, query?: string}} view
 * @returns {Array<{name: string, path: string, total: number, items: Array<object>}>} `total`: the project's
 *   saved sessions; `items`: those matching `query`.
 */
export function sessionGroups({ recent, projects, scope, group = null, query = "" }) {
  const needle = query.trim().toLowerCase();
  return viewProjects({ projects, scope, group })
    .map((project) => {
      const own = recent.filter((item) => item.project === project.path);
      return { name: project.name, path: project.path, total: own.length, items: own.filter((item) => sessionMatches(item, needle)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
