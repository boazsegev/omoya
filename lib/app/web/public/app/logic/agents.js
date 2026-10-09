/** Agent identity across projects: names are unique per project only. */
import { aggregateState } from "../../format.js";

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

/**
 * Sort display snapshots by name at every level without changing server lifecycle order.
 * @param {Array<object>} agents Agent snapshot (not mutated or retained).
 * @returns {Array<object>} New root and child snapshots sorted by display name.
 */
export function sortedAgents(agents) {
  return agents.map((agent) => ({ ...agent, children: sortedAgents(agent.children ?? []) }))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/** An agent tree flattened, parent before children. */
function agentTree(agent) { return [agent, ...(agent.children ?? []).flatMap(agentTree)]; }

/** An agent snapshot's state: "working" while it runs a turn, else its reported state. */
function agentState(agent) { return agent.busy ? "working" : agent.state ?? "idle"; }

/**
 * Group running root agents (with their linked children) by project, projects
 * sorted alphabetically; only projects with running agents appear.
 * @param {{agents: Array<object>, projects: Array<{name: string, path: string}>}} view
 * @returns {Array<{name: string, path: string, total: number, state: string, items: Array<object>}>}
 *   `total`: the project's agents, children included; `state`: their aggregate ("working" > "disconnected" > "idle").
 */
export function agentGroups({ agents, projects }) {
  const groups = new Map();
  for (const agent of agents) {
    const path = agent.project ?? "";
    if (!groups.has(path)) groups.set(path, { name: projects.find((item) => item.path === path)?.name ?? path, path, items: [] });
    groups.get(path).items.push(agent);
  }
  return [...groups.values()]
    .map((group) => { const all = group.items.flatMap(agentTree); return { ...group, total: all.length, state: aggregateState(all.map(agentState)) }; })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
