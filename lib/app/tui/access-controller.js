/** Private access-menu execution. Reducers capture targets; tasks own asynchronous work. */
import Env from "../../env.js";
import { effect } from "../gtui/gtui.js";
import { endpointPolicySet } from "../shared/endpoint-policy.js";
import { listEndpointModels, readLastCombo } from "../shared/catalog.js";
import { buildAccessItems, terminalSettingAllowed } from "./access-menu.js";
import { createForm, updateForm, formErrors } from "./form.js";
import { pushMenu } from "./overlay-controller.js";
import { contextActionMenu, contextEditForm, applyContextSave, applyContextMutation } from "./context-actions.js";

const result = (model, overlay, effects = []) => ({ model: { ...model, overlay }, effects });
const field = (name, label, value = "", options = {}) => ({ name, label, value, ...options });
const alive = (agent) => agent && !agent.closed && !agent.closeMarked && !agent.env?.closed;

/** Write exactly one allowed leaf; never replace a live settings namespace. */
function terminalWrite(key, value) {
  if (!terminalSettingAllowed(key, value)) throw new TypeError("Unsupported terminal preference.");
  const parts = key.split(".");
  let target = Env.settings;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === undefined) {
      if (value === undefined) return;
      target[part] = {};
    }
    target = target[part];
  }
  if (value === undefined) delete target[parts.at(-1)];
  else target[parts.at(-1)] = value;
}

/** Never put a submitted token into an error message or diagnostic outcome. */
function errorText(error, operation) {
  let text = String(error?.message ?? error ?? "Operation failed.");
  for (const descriptor of operation.fields ?? []) {
    const secret = operation.values?.[descriptor.name];
    if (descriptor.secret && secret) text = text.replaceAll(secret, "[masked]");
  }
  return text;
}

/**
 * Create the private access reducer; dependencies are borrowed and never closed here.
 * @param {object} options Workspace and current-target getters, plus effect/tool adapters.
 * @param {object} options.workspace Public private-workspace contract; owns acquisitions.
 * @param {Function} options.getAgent Returns the real, currently viewed Agent (not a proxy).
 * @param {Function} options.getEnv Returns the currently viewed Env.
 * @param {Function} options.getOptions Returns a fresh access-menu snapshot.
 * @param {Function} options.runCommandEffect Builds a command effect capturing its current Agent.
 * @param {Function} options.copyEffect Builds a host clipboard effect.
 * @param {Function} options.openContext Opens the viewer and returns a transition.
 * @param {Function} options.runTool Runs (name, JSON object, captured Agent) through the existing tool pipeline.
 * @returns {{resolve:Function,update:Function,refresh:Function,close:Function}} Synchronous reducers, menu refresh, and idempotent lifetime invalidation.
 * Supported reducers return {model,effects}; unsupported descriptors/messages return undefined.
 * Forms retain targets/secrets until dismissed. Tasks mutate only captured targets; completion changes
 * the UI only while overlay === operation. Cancellation abandons UI ownership, not admitted work.
 * Selections return model.accessSelectedAgent for the parent to switch/clear. Parent owns session
 * cache updates from access.sessions.ready. Failures keep form values; dependency errors become
 * form errors. No filesystem or tool work runs on the key path. No inputs are mutated.
 */
export function createAccessController({ workspace, getAgent, getEnv, getOptions, runCommandEffect, copyEffect, openContext, runTool }) {
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error("Access controller is closed.");
  }

  function refresh(overlay) {
    if (overlay?.type !== "menu" || !Array.isArray(overlay.stack)) return overlay;
    const options = getOptions();
    return { ...overlay, stack: overlay.stack.map((level) => {
      const fresh = level.source && buildAccessItems(level.source, options);
      return fresh ? { ...level, title: fresh.title, items: fresh.items } : level;
    }) };
  }

  function sessionsEffect() {
    return effect.task("access.sessions", async ({ send }) => {
      if (closed) return;
      try {
        const sessions = await workspace.sessions();
        if (!closed) send({ type: "access.sessions.ready", sessions });
      } catch (error) {
        if (!closed) send({ type: "access.sessions.ready", error: String(error?.message ?? error) });
      }
    });
  }

  function form(model, title, fields, action, { details = "", submitLabel = "Save", back = model.overlay } = {}) {
    return result(model, createForm({ title, fields, action, details, submitLabel, back }));
  }

  function failed(model, error) {
    const overlay = createForm({ title: "Action unavailable", fields: [], action: { type: "access.unavailable" }, back: model.overlay, submitLabel: "Close" });
    return result(model, formErrors(overlay, String(error?.message ?? error)));
  }

  function operationStart(model, operation, action, values = {}) {
    const origin = getAgent();
    const task = effect.task(Symbol("access.operation"), async ({ send }) => {
      if (closed) return;
      let outcome;
      let failure;
      try {
        if (alive(origin)) workspace.remember?.(origin);
        outcome = await actionRun(action, values, operation);
      } catch (error) { failure = errorText(error, operation); }
      finally {
        // Workspace commands remember their result internally. Restore the actual UI
        // selection even after cancellation; the parent remembers a successful switch.
        const current = getAgent();
        if (!closed && alive(current)) {
          try { workspace.remember?.(current); }
          catch (error) { failure ??= errorText(error, operation); }
        }
      }
      if (closed) return;
      if (failure) {
        const fieldName = ({ "access.project.open.save": "path", "access.project.description.save": "text", "access.project.group.save": "group",
          "access.agent.rename.save": "name", "access.session.rename.save": "name", "access.endpoint.max.save": "maxActive", "access.tool.run": "json", "access.context.save": "text" })[action.type];
        if (fieldName) failure = { [fieldName]: failure };
      }
      send({ type: "access.operation.done", operation, origin, ...(failure ? { error: failure } : outcome) });
      if (["access.session.rename.save", "access.session.delete", "access.session.resume"].includes(action.type)) {
        try { send({ type: "access.sessions.ready", sessions: await workspace.sessions() }); }
        catch (error) { send({ type: "access.sessions.ready", error: String(error?.message ?? error) }); }
      }
    });
    return result(model, operation, [task]);
  }

  function pending(model, title, action, { details = "", back = model.overlay, preparing = false } = {}) {
    const operation = { ...createForm({ title, fields: [], action, details, back, submitLabel: "Continue" }), busy: true, preparing };
    return operationStart(model, operation, action);
  }

  function confirmation(model, title, action, details) {
    return form(model, title, [], action, { details, submitLabel: "Confirm" });
  }

  function addForm(target, action, back) {
    const source = action.origin?.env === target ? action.origin : undefined;
    const models = [...(target.models?.().values() ?? [])].filter((info) => info.listed)
      .map((info) => `${info.endpoint}/${info.model}`).sort();
    const model = source?.model ?? readLastCombo(target) ?? models[0] ?? "";
    return createForm({
      title: "Add agent", back, submitLabel: "Add agent",
      details: `Project: ${target.name ?? target.folder}. Read-only can narrow the permissions an agent inherits, never widen them.`,
      fields: [field("model", "Model", model, { options: models.map((value) => ({ label: value, value, group: value.split("/")[0] })) }),
        field("safe", "Tool access", String(source?.can?.write === false), { custom: false, options: [{ label: "Read/write", value: "false" }, { label: "Read-only", value: "true" }] }),
        field("anonymous", "Conversation logging", String(source?.context?.save === false), { custom: false, options: [{ label: "Logged", value: "false" }, { label: "Unlogged", value: "true" }] })],
      action: { type: "access.agent.add", env: target, origin: action.origin },
    });
  }

  function validate(action, values) {
    const errors = {};
    if (action.type === "access.agent.add") {
      for (const name of ["safe", "anonymous"]) {
        if (values[name] !== "true" && values[name] !== "false") errors[name] = "Enter true or false.";
      }
    }
    if (action.type === "access.endpoint.max.save" && values.maxActive.trim() !== ""
      && (!/^\d+$/u.test(values.maxActive.trim()) || !Number.isSafeInteger(Number(values.maxActive.trim())))) {
      errors.maxActive = "Enter a non-negative integer, or leave blank to inherit.";
    }
    if (action.type === "access.tool.run") {
      try {
        const args = JSON.parse(values.json);
        if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error();
        const required = action.schema?.parameters?.required ?? action.schema?.inputSchema?.required ?? action.schema?.required ?? [];
        const missing = required.filter((name) => !Object.hasOwn(args, name));
        if (missing.length) errors.json = `Required arguments: ${missing.join(", ")}.`;
      } catch { errors.json = "Enter a JSON object of tool arguments."; }
    }
    if (action.type === "access.login.save") {
      if (!["package", "local"].includes(values.scope)) errors.scope = "Choose package or local.";
      for (const name of ["name", "provider", "url"]) if (!values[name].trim()) errors[name] = "This field is required.";
    }
    if (action.type === "access.project.group.save" && (!values.group.trim() || values.group.includes("/")
      || ["__proto__", "constructor", "prototype"].includes(values.group.trim()))) errors.group = "Enter a nonblank group without '/' or a reserved object key.";
    return errors;
  }

  async function actionRun(action, values, operation) {
    const back = operation.back;
    switch (action.type) {
      case "access.project.open.save": return { agent: await workspace.select(values.path.trim()) };
      case "access.project.select": return { agent: await workspace.select(action.path) };
      case "access.project.pin":
        workspace.pin(action.path, action.pinned);
        await Env.settingsFlush();
        return { overlay: back };
      case "access.project.group":
      case "access.project.group.save":
        workspace.group(action.path, action.group ?? values.group.trim(), action.member ?? true);
        await Env.settingsFlush();
        return { overlay: back };
      case "access.project.description.save":
        workspace.describe(action.path, values.text);
        await Env.settingsFlush();
        return { overlay: back };
      case "access.project.close": {
        const target = workspace.projects().find((project) => project.path === action.path)?.env;
        if (target) workspace.enroll?.(target);
        const replacement = await workspace.closeProject(action.path);
        return { agent: alive(action.origin) && action.origin.env?.folder !== action.path ? action.origin : replacement };
      }
      case "access.add.form": return { overlay: addForm(await workspace.open(action.path), action, back) };
      case "access.agent.add": {
        const target = action.env ?? await workspace.open(action.path);
        assertOpen();
        const options = { env: target };
        if (Object.hasOwn(values, "safe")) {
          options.safe = values.safe === "true";
          options.anonymous = values.anonymous === "true";
          if (values.model.trim()) options.model = values.model.trim();
        } else {
          if (action.safe !== undefined) options.safe = action.safe;
          if (action.anonymous !== undefined) options.anonymous = action.anonymous;
          if (action.model !== undefined) options.model = action.model;
        }
        if (alive(action.origin)) workspace.remember?.(action.origin);
        return { agent: await workspace.add(options) };
      }
      case "access.agent.rename.save":
        action.agent.name = values.name.trim();
        await action.agent.context?.flush?.();
        return { overlay: back };
      case "access.session.resume": return { agent: await workspace.resume(action.session) };
      case "access.session.rename.save": {
        if (action.session.live?.context?.save === false || !action.session.id) throw new Error("Unlogged sessions cannot be renamed.");
        await workspace.renameSession(action.session, values.name.trim());
        const source = { type: "access.sessions", project: action.session.project };
        const menu = buildAccessItems(source, getOptions());
        return { overlay: pushMenu(null, menu.title, menu.items, source) };
      }
      case "access.session.delete": {
        await workspace.deleteSession(action.session);
        if (action.session.live === action.origin || !alive(action.origin)) return { agent: await workspace.select(action.origin.env.folder) };
        return { overlay: null };
      }
      case "access.terminal.set":
        terminalWrite(action.key, action.value);
        await Env.settingsFlush();
        return { overlay: back };
      case "access.endpoint.max.save":
        endpointPolicySet(action.env, action.selector, { maxActive: values.maxActive.trim() === "" ? undefined : Number(values.maxActive.trim()) === 0 ? false : Number(values.maxActive.trim()) });
        await action.env.settingsFlush();
        return { overlay: back };
      case "access.tool.run": return { overlay: null, text: await runTool(action.name, JSON.parse(values.json), action.agent) };
      case "access.login.save": {
        const endpoint = await action.env.login(values.name.trim(), { provider: values.provider.trim(), url: values.url.trim(), token: values.token || undefined }, { scope: values.scope });
        const first = listEndpointModels(action.env).find(({ name }) => name === endpoint.name)?.models[0];
        if (!closed && first && alive(action.agent)) action.agent.model = `${endpoint.name}/${first}`;
        return { overlay: null };
      }
      case "access.context.save": return { overlay: applyContextSave(action, values) ?? null };
      case "access.context.delete":
      case "access.context.rollback": return { overlay: applyContextMutation(action) ?? null };
      case "access.context.fork": {
        const fresh = await action.agent.fork({ through: action.through });
        try {
          assertOpen();
          workspace.own?.(fresh);
        } catch (error) {
          await fresh.close();
          throw error;
        }
        return { agent: fresh };
      }
      case "access.unavailable": return { overlay: back ?? null };
      default: throw new Error("Unsupported access operation.");
    }
  }

  function contextEdit(model, value) {
    const block = value.block;
    return result(model, contextEditForm(value.agent ?? getAgent(), value.index ?? block?.sourceMessage ?? block?.resultMessage ?? block?.sourceMessageIndex ?? block?.message,
      value.blockIndex ?? block?.contentIndex, value.viewer ?? model.overlay));
  }

  function resolve(model, value) {
    if (closed || !value || typeof value !== "object") return undefined;
    try {
      const menu = buildAccessItems(value, getOptions());
      if (menu) {
        // A list filter is a view of the same page, not another navigation level.
        const current = model.overlay?.type === "menu" ? model.overlay.stack.at(-1) : undefined;
        const replacing = ["access.projects", "access.sessions"].includes(value.type) && current?.source?.type === value.type;
        const parent = replacing ? { ...model.overlay, stack: model.overlay.stack.slice(0, -1) } : model.overlay;
        return result(model, pushMenu(parent, menu.title, menu.items, value), value.type === "access.sessions" ? [sessionsEffect()] : []);
      }
      switch (value.type) {
        case "access.project.open": return form(model, "Open project folder", [field("path", "Folder path", "", { required: true })], { type: "access.project.open.save" }, { submitLabel: "Open" });
        case "access.project.select": return pending(model, "Selecting project…", { ...value, origin: getAgent() }, { details: workspace.projects().find((project) => project.path === value.path)?.name ?? "" });
        case "access.project.pin":
        case "access.project.group": return pending(model, "Saving project details…", value);
        case "access.project.group.new": return form(model, "Create project group", [field("group", "Group", "", { required: true })], { type: "access.project.group.save", path: value.path }, { details: "Joining a group pins this project and lets its agents reach the other members' resources." });
        case "access.project.description": return form(model, "Project description", [field("text", "Description", workspace.projects().find((project) => project.path === value.path)?.description ?? "", { multiline: true })], { type: "access.project.description.save", path: value.path });
        case "access.project.close": {
          const name = workspace.projects().find((project) => project.path === value.path)?.name ?? "this project";
          return confirmation(model, "Close project?", { ...value, origin: getAgent() }, `Close ${name}? The project stays pinned.`);
        }
        case "access.add.form": {
          const action = { ...value, origin: getAgent() };
          const target = getEnv()?.folder === value.path ? getEnv()
            : workspace.projects().find((project) => project.path === value.path)?.env;
          if (target && !target.closed) return result(model, addForm(target, action, model.overlay));
          return pending(model, "Loading agent options…", action, { details: "No agent has been added. Choose options, then select Add agent.", preparing: true });
        }
        case "access.agent.add": return pending(model, "Adding agent…", { ...value, origin: getAgent() }, { details: value.path });
        case "access.agent.rename": {
          const agent = value.agent ?? getAgent();
          return form(model, "Rename agent", [field("name", "Name", agent.name, { required: true })], { type: "access.agent.rename.save", agent });
        }
        case "access.session.resume": return pending(model, "Resuming saved session…", { ...value, origin: getAgent() }, { details: value.session.id });
        case "access.session.rename": {
          const action = { type: "access.session.rename.save", session: value.session };
          const opened = form(model, "Rename saved session", [field("name", "Session name", value.session.name ?? value.session.id, { required: true })], action);
          return value.session.live?.context?.save === false || !value.session.id
            ? result(model, formErrors(opened.model.overlay, "Unlogged sessions cannot be renamed.")) : opened;
        }
        case "access.session.delete": return confirmation(model, "Delete saved session?", { ...value, origin: getAgent() }, `Delete ${value.session.name ?? value.session.id} in ${value.session.projectName ?? value.session.project ?? value.session.env?.name ?? "this project"}? Idle live owners will be closed. This cannot be undone.`);
        case "access.terminal.set":
          if (!terminalSettingAllowed(value.key, value.value)) return failed(model, new Error("Unsupported terminal preference."));
          return pending(model, "Saving personal terminal preference…", value, { details: "Personal settings only · applies next launch. Project overrides may take precedence." });
        case "access.endpoint.max": return form(model, "Endpoint maximum active", [field("maxActive", "Maximum active", value.value === undefined ? "" : value.value === false ? "0" : value.value)], { type: "access.endpoint.max.save", env: getEnv(), selector: value.selector }, { details: "Applies to the viewed project. Leave blank to inherit, enter 0 to exclude, or enter a positive limit." });
        case "access.tool": {
          const schema = value.schema;
          const required = schema?.parameters?.required ?? schema?.inputSchema?.required ?? schema?.required ?? [];
          return form(model, `Run ${value.name}`, [field("json", "JSON arguments", "{}", { multiline: true, required: true })], { type: "access.tool.run", name: value.name, schema, agent: getAgent() }, { submitLabel: "Run", details: [schema?.description, required.length ? `Required arguments: ${required.join(", ")}.` : "No required arguments.", "Review arguments before explicitly choosing Run."].filter(Boolean).join("\n") });
        }
        case "access.viewer": return openContext(model, value.index, value.blockIndex);
        case "access.context.actions": return result(model, contextActionMenu(value.agent ?? getAgent(), value.block, value.viewer ?? model.overlay));
        case "access.context.back": return result(model, value.viewer ?? null);
        case "access.context.copy": return result(model, value.viewer ?? model.overlay, [copyEffect(value.block?.text ?? "")]);
        case "access.context.edit": return contextEdit(model, value);
        case "access.context.delete":
        case "access.context.rollback": return confirmation(model, value.type === "access.context.delete" ? "Delete context message?" : "Roll back context?", value, value.type === "access.context.delete" ? `Delete message ${value.index}? This cannot be undone.` : `Remove message ${value.index} and every later message? This cannot be undone.`);
        case "access.context.fork": return pending(model, "Forking context…", value);
        case "insert": {
          if (typeof value.text !== "string" || !value.text.startsWith("/endpoint-login ")) return undefined;
          const [scope = "package", name = "", provider = "", url = "", token = ""] = value.text.trim().split(/\s+/u).slice(1);
          return form(model, "Endpoint login", [field("scope", "Scope", scope, { required: true, custom: false, options: [{ label: "Package", value: "package" }, { label: "Local", value: "local" }] }), field("name", "Endpoint name", name, { required: true }), field("provider", "Provider", provider, { required: true }), field("url", "URL", url, { required: true }), field("token", "Token", token, { secret: true })], { type: "access.login.save", agent: getAgent(), env: getEnv() }, { submitLabel: "Login", details: "Credentials go straight to the project's credential store, never into command history." });
        }
        case "command": return { model: { ...model, overlay: null }, effects: [runCommandEffect(value.lines)] };
        default: return undefined;
      }
    } catch (error) { return failed(model, error); }
  }

  function update(model, message) {
    if (closed) return undefined;
    if (message?.type === "access.operation.done") {
      if (model.overlay !== message.operation) {
        // Admitted deletion/closure may finish after Escape. Never steal a live
        // view, but do not strand an already-closed view without a replacement.
        return message.agent && !alive(getAgent()) ? { model: { ...model, accessSelectedAgent: message.agent }, effects: [] } : { model, effects: [] };
      }
      if (message.error) return result(model, formErrors(message.operation, message.error));
      const next = { ...model, overlay: refresh(Object.hasOwn(message, "overlay") ? message.overlay : null) };
      if (message.agent) next.accessSelectedAgent = message.agent;
      return { model: next, effects: [] };
    }
    if (model.question) return undefined;
    if (message?.type === "access.context.edit") return resolve(model, message);
    if (model.overlay?.type !== "form") return undefined;
    const reduced = updateForm(model.overlay, message);
    if (!reduced.handled) return undefined;
    if (reduced.cancel) return result(model, refresh(model.overlay.back ?? null));
    if (!reduced.submit) return result(model, reduced.overlay);
    const { action, values } = reduced.submit;
    const errors = validate(action, values);
    if (Object.keys(errors).length) return result(model, formErrors(reduced.overlay, errors));
    return operationStart(model, reduced.overlay, action, values);
  }

  return { resolve, update, refresh, close: () => { closed = true; } };
}
