/** Agent identity across projects: names are unique per project only. */

/** Whether two agent snapshots name the same agent. */
export function sameAgent(a, b) { return Boolean(a && b) && a.id === b.id && a.project === b.project; }

/** A Map key for per-agent client state (drafts). */
export function agentKey(agent) { return agent?.id ? `${agent.project ?? ""}\n${agent.id}` : null; }

/** Packet fields addressing `agent` (its project lets the all-projects view reach it). */
export function agentRef(agent) { return { agentId: agent.id, ...(agent.project ? { project: agent.project } : {}) }; }

/**
 * The projects a view shows: every served project (the all-projects view),
 * a group's members (a group view), or the current project (a project view).
 * @param {{projects: Array<{path: string, current?: boolean, groups?: string[]}>, scope: string, group?: string|null}} view
 * @returns {Array<object>} the shown project records, in served order.
 */
export function viewProjects({ projects, scope, group }) {
  if (scope === "all") return projects;
  if (scope === "group") return projects.filter((item) => item.groups?.includes(group));
  return projects.filter((item) => item.current);
}

/** The project name of an agent while several projects are visible (a multi-project view), else null. */
export function agentProjectLabel(agent, view) {
  if (view.scope === "project" || viewProjects(view).length < 2) return null;
  return view.projects.find((item) => item.path === agent.project)?.name ?? null;
}

/** An agent's display name: `<project>/<agent>` while several projects are visible, else its name. */
export function agentDisplayName(agent, view) {
  const name = agent.name || agent.id;
  const project = agentProjectLabel(agent, view);
  return project ? `${project}/${name}` : name;
}
