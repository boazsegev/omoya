/** Header status and active project, independent of browser globals. */
export function headerPresentation({ isOnline, activity, throttledUntil, projects, now }) {
  const label = !isOnline ? "Reconnecting" : activity === "working" ? "Working" : activity === "disconnected" ? "Disconnected" : "Ready";
  const wait = throttledUntil && throttledUntil > now ? ` · continuing in ${Math.ceil((throttledUntil - now) / 1000)}s` : "";
  return { label, wait, accessibleLabel: `Connection: ${label}${wait}`, project: projects.find((item) => item.current) ?? null };
}

/** Decode every URL path segment (malformed escapes stay as written). */
const decodedPath = (path) => path.split("/").map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join("/");

/** A group view's URL: `/group:<group>/`. */
export function groupUrl(group) { return `/group:${encodeURIComponent(group)}/`; }

/** Whether a group view is reachable: a project URL of the same path wins over it. */
export function groupReachable(group, projects) {
  const url = decodedPath(groupUrl(group));
  return !projects.some((item) => item.url && decodedPath(item.url) === url);
}

/** Describe the project menu without navigation or prompting side effects.
 * Project rows switch projects (in place when the view shows them: `inView`);
 * `view` rows open the all-projects URL, each reachable group's view
 * (`/group:<group>/`), or the current project's URL.
 * @param {Array<object>} projects - Served project records.
 * @param {boolean} canManageProjects - Whether the add row is offered.
 * @param {string} [scope="project"] - "all" | "group" | "project".
 * @param {string|null} [group=null] - The viewed group (scope "group").
 * @returns {Array<object>} menu rows.
 */
export function projectChoices(projects, canManageProjects, scope = "project", group = null) {
  const choices = projects.map(({ name, path, current, url, groups }) => ({ label: name, detail: path, current, url, path,
    ...(scope === "all" || (scope === "group" && groups?.includes(group)) ? { inView: true } : {}) }));
  const current = projects.find((item) => item.current);
  const views = [];
  if (scope !== "all" && projects.length > 1) views.push({ label: "All projects", detail: "Show every project's agents", url: "/", view: true });
  for (const name of [...new Set(projects.flatMap((item) => item.groups ?? []))].sort()) {
    if ((scope === "group" && name === group) || !groupReachable(name, projects)) continue;
    const size = projects.filter((item) => item.groups?.includes(name)).length;
    views.push({ label: `Group: ${name}`, detail: `Show the agents of its ${size} project${size === 1 ? "" : "s"}`, url: groupUrl(name), view: true });
  }
  if (scope !== "project" && current && projects.length > 1) views.push({ label: `Only ${current.name}`, detail: "Hide other projects' agents", url: current.url, view: true });
  if (views.length) choices.push({ separator: true }, ...views);
  if (canManageProjects) choices.push({ separator: true }, { label: "Add project…", add: true });
  return choices;
}

/** Describe a project's group menu: every known group (✓ = member; picking toggles), then "New group…".
 * @param {{groups?: string[]}} project - The project the menu edits.
 * @param {Array<{groups?: string[]}>} projects - Every listed project (their groups are the known ones).
 * @returns {Array<object>} `{label, group, member, current}` rows, a separator, and `{label, create: true}`.
 */
export function groupChoices(project, projects) {
  const known = [...new Set(projects.flatMap((item) => item.groups ?? []))].sort();
  const member = new Set(project.groups ?? []);
  const rows = known.map((group) => ({ label: group, group, member: !member.has(group), current: member.has(group) }));
  return [...rows, ...(rows.length ? [{ separator: true }] : []), { label: "New group…", create: true }];
}
