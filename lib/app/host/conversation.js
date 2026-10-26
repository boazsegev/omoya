import { randomUUID } from "node:crypto";
import Context from "../../context.js";

const staged = new WeakSet();
function sessionIdCheck(id) {
  if (typeof id !== "string" || id.trim() !== id || !/^[^\s/\\]{1,64}$/.test(id) || id === "." || id === "..") {
    throw new Error(`invalid session name "${id}"`);
  }
}

/** Complete a same-id restart after the previous Agent closes its file. */
export function conversationActivate(agent) {
  if (staged.delete(agent)) agent.context.save = true;
  agent.context.flush();
}

/** Construct a replacement before releasing its predecessor. The caller owns attachment and closure.
 * A "new" without an id inherits the current logging preference; `false` is memory-only.
 * @returns {Promise<object>} The new Agent after its environment factory completes.
 */
export async function conversationCreate(current, { kind = "new", id, through } = {}) {
  if (!["new", "fork", "resume"].includes(kind)) throw new TypeError(`unknown conversation operation "${kind}"`);
  if (kind === "fork") return current.fork({ id, through });
  if (current.busy || current.closeMarked || current.closed) throw new Error("cannot replace a closed or running session");
  const env = current.env;
  if (!env?.agentCreate) throw new TypeError("session replacement requires an Env agent factory");
  const base = { model: current.model, folder: current.folder };
  let options;
  let deferredSave = false;
  if (kind === "resume") {
    // Persist the idle source before reading it from disk, including when
    // resuming the currently viewed id.
    current.context.flush();
    if (!Context.fileOf({ dir: env.settings.sessions, id })) throw new Error(`no session "${id}"`);
    // The constructor checks origin and restores stored preferences. A stored
    // model takes precedence; only fall back to the current model if absent.
    options = { ...base, can: { ...current.can }, model: undefined, contextId: id };
  } else {
    // A new conversation starts with Agent's default capabilities; only
    // the logging preference, model, folder and thinking carry over.
    // An omitted id inherits the current logging preference: a fresh
    // generated id when the current session logs, memory-only otherwise.
    if (id === undefined) id = current.context.save === false ? false : randomUUID();
    const context = new Context({ id, save: false });
    if (context.id) sessionIdCheck(id);
    if (context.id && id === current.context.id) {
      // Stage an unsaved store. Even a constructor/setting failure must not
      // overwrite or remove the source file while the old Agent owns it.
      deferredSave = current.context.save !== false;
      const messages = [];
      for (const text of env.systemPrompt?.() ?? []) Context.messageAppend(messages, Context.messageSystem(text));
      options = { ...base, context: new Context({ id, dir: current.context.dir,
        origin: current.context.origin, uuid: current.context.uuid,
        name: current.context.name, save: false, messages }) };
    } else if (context.id && Context.fileOf({ dir: env.settings.sessions, id })) {
      throw new Error(`session "${id}" already exists`);
    } else options = { ...base, contextId: context.id ? id : false,
      contextSave: !!context.id && current.context.save !== false };
  }
  let fresh;
  try {
    fresh = await env.agentCreate(options);
    if (kind === "resume") {
      if (fresh.model === undefined && current.model !== undefined) {
        try { fresh.model = current.model; } catch { /* unavailable endpoint */ }
      }
    } else fresh.thinking = current.thinking;
    // A newly constructed Agent has no per-conversation work state.
    if (deferredSave) staged.add(fresh);
    return fresh;
  } catch (error) {
    if (fresh) void fresh.close().catch(() => {});
    if (options.context && !fresh) void options.context.close().catch(() => {});
    throw error;
  }
}
