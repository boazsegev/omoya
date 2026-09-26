/**
 * lib/gtui/msg.js — the Msg/Cmd/Sub CONTRACTS gtui's Elm architecture
 * runs on (Model → Update → View, Bubble Tea's message-passing). The
 * live runtime is lib/gtui/gtui.js; this island (with lib/gtui/widgets/)
 * is retained, tested, and currently unwired.
 *
 * No classes — a Msg is a plain tagged object `{type, ...payload}`,
 * matching this codebase's existing event style (context.js's
 * MessageType/ContentType are the same shape). A Cmd is a plain
 * `{run}` descriptor: `run()` returns a Promise of the Msg(s) it
 * produces (or null/undefined for none) — `update()` itself never
 * performs IO; a side effect becomes a Cmd program.js's runtime awaits
 * and dispatches. A Sub is a plain `{id, ...payload}` descriptor a
 * Program declares from its model (e.g. "tick every 1000ms while
 * busy") — the DRIVER (a later phase) owns actually starting/stopping
 * the underlying timer/listener by diffing Sub ids across renders;
 * this module only defines the shape.
 */

/** A tagged Msg: `{type, ...payload}`. Sugar only — a plain object literal works too. */
export function msg(type, payload = {}) {
  return { type, ...payload };
}

/** A Cmd wrapping a `run()` side effect. */
export function cmd(run) {
  return { run };
}

/** The "no command" value — `update()` returns this when nothing runs. */
export const NONE = null;

/**
 * Combine several Cmds (any `NONE`s dropped) into one: running it
 * runs every wrapped Cmd concurrently and flattens their resulting
 * Msgs into one array. `NONE` when nothing is left; the single Cmd
 * itself when only one survives (no needless wrapping).
 * @param {Array<{run: Function}|null>} cmds
 * @returns {{run: Function}|null}
 */
export function batchCmds(cmds) {
  const list = cmds.filter((c) => c !== NONE);
  if (list.length === 0) return NONE;
  if (list.length === 1) return list[0];
  return cmd(async () => {
    const results = await Promise.all(list.map((c) => c.run()));
    return results.flatMap((r) => (r === null || r === undefined ? [] : Array.isArray(r) ? r : [r]));
  });
}

/** A tagged Sub: `{id, ...payload}` — `id` is what the driver diffs across renders. */
export function sub(id, payload = {}) {
  return { id, ...payload };
}
