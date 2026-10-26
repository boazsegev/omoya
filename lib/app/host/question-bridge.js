/** Pending user responses belong to the interactive bridge, not to the Agent's busy state. */
const pending = new WeakMap();

/** Whether an Agent currently has an unanswered interactive request. */
export function waitingForUser(agent) { return (pending.get(agent)?.size ?? 0) > 0; }

/** Install a host-owned interactive bridge and restore only if it is still ours.
 * @param {object} agent Agent receiving the bridge.
 * @param {object} bridge Host bridge with ask(), and optionally timeout().
 * @param {() => void} [onChange] Notified when pending-answer status changes.
 * @returns {() => void} Idempotent bridge disposer.
 */
export function questionBridgeInstall(agent, bridge, onChange) {
  const prior = agent.question;
  const outstanding = new Set();
  const notify = () => { if (typeof onChange === "function") onChange(); };
  const wrapped = Object.assign(Object.create(bridge), {
    ask(questions) {
      const result = bridge.ask(questions);
      const token = {};
      outstanding.add(token);
      pending.set(agent, outstanding);
      if (outstanding.size === 1) notify();
      return Promise.resolve(result).finally(() => {
        outstanding.delete(token);
        if (outstanding.size === 0 && pending.get(agent) === outstanding) { pending.delete(agent); notify(); }
      });
    },
    timeout(...args) {
      try { return bridge.timeout?.(...args); }
      finally { if (outstanding.size && pending.get(agent) === outstanding) { outstanding.clear(); pending.delete(agent); notify(); } }
    },
  });
  agent.question = wrapped;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (pending.get(agent) === outstanding) { pending.delete(agent); notify(); }
    if (agent.question === wrapped) agent.question = prior;
  };
}
