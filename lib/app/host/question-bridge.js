/** Install a host-owned interactive bridge and restore only if it is still ours. */
export function questionBridgeInstall(agent, bridge) {
  const prior = agent.question;
  agent.question = bridge;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (agent.question === bridge) agent.question = prior;
  };
}
