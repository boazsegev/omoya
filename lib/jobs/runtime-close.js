/** Close only explicitly supplied Jobs runtime resources, awaiting durable teardown. */
/**
 * Release a job's Agent or a dispatcher-owned Env after its jobs finish.
 * @param {{env?: object, agent?: object}} [runtime] Owned resource identities; neither is retained.
 * @returns {Promise<{agent?: object, session: {id: string, file?: string}|null}>} Closed Agent and final context identity.
 * @throws {Error} Propagates close failures; callers report them as job/dispatch errors.
 * @effects Closes the supplied Agent before the supplied Env; does not close other agents registered with an Env.
 */
export async function jobRuntimeClose({ env, agent } = {}) {
  const session = agent?.context ? { id: agent.context.id, file: agent.context.file } : null;
  const errors = [];
  try { await agent?.close?.(); } catch (error) { errors.push(error); }
  try { await env?.close?.(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Jobs runtime close failed");
  return { agent, session };
}
