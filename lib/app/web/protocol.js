/**
 * lib/web-app/protocol.js — the WebSocket wire contract between the web
 * server and its browser SPA. Pure validation + shaping; no Agent/Env
 * knowledge, no DOM, no Bun. Both the server (lib/web-app/session.js,
 * server.js) and the client (public/app.js's own small sender) speak in
 * these packet shapes.
 *
 * Direction: client → server packets are VALIDATED (untrusted input);
 * server → client packets are plain facts (the server never re-validates
 * its own output). Every packet has a `type` string.
 *
 * Client → server:
 *   chat.submit        {text,attachments?}        send text followed by uploaded files (or /command)
 *   chat.cancel        {}                         cancel the running turn
 *   chat.unqueue       {}                         remove queued messages for editing
 *   chat.continue      {}                         re-activate the agent over its context (no message)
 *   question.answer    {requestId, answers|null}  resolve an open question
 *   project.add        {path}                     add an existing absolute directory or ~/… / ~ (local clients only; the all-projects view then switches to it)
 *   project.pin        {path, pinned}             pin (user projects.json: served at every start) or unpin a served project (local clients only)
 *   project.group      {path, group, member}      add (member) or remove a served project's group (no `/`); joining pins it (local clients only)
 *   project.remove     {path}                     stop serving a project, unpinning it and closing its idle agents (local clients only)
 *   project.select     {path}                     all-projects view: view that project's first agent (else a new one)
 *   session.list       {}
 *   session.new        {anonymous?, safe?}        replace viewed agent with a fresh session (saved by default)
 *   session.add        {model?, safe?}            add a new agent (keep current), optionally on "endpoint/model"
 *   session.fork       {id?}                      fork current session into a logged branch
 *   session.switch     {agentId, project?}        project: the agent's project path (all-projects view)
 *   session.close      {agentId, project?}        close one open agent
 *   session.resume     {id, project?}             replace viewed agent with resumed session; another project's
 *                                                 (all-projects view): view it there (its running agent, else a new one)
 *   session.rename     {name, id?, project?}      rename a saved session (default: the viewed agent's)
 *   session.delete     {id, project?}             delete a saved session (closes its idle agent if open)
 *   session.clear      {}                         clear the viewed session and restart it (/session-delete!)
 *   agent.rename       {agentId?, name, project?} set an agent's display name (default: the viewed one)
 *   settings.safe      {on:boolean}
 *   settings.thinking  {level}
 *   settings.session-save {on:boolean}            (on: log the whole conversation from now on)
 *   settings.model     {model:"endpoint/model"|"model"|"endpoint"}
 *   settings.spawn     {value:true|false|null}    delegation permission (null = the tool asks)
 *   settings.theme     {name}                     persist web.theme; "system" follows browser preference
 *   endpoint.list      {}                         request endpoints + login presets
 *   endpoint.login     {scope,name,provider,url,token?}  add an endpoint (direct form)
 *   endpoint.oauth     {name}                     start a preset's browser sign-in
 *   endpoint.oauth-paste {input}                  feed a pasted redirect URL / code#state
 *   endpoint.logout    {name}                     remove an endpoint (settings + auth)
 *   endpoint.policy    {selector,change}          set <endpoint> {disabled:boolean} or <endpoint>[/<model>] {maxActive:n|false|null(inherit)}
 *   context.inspect    {}                         request real context blocks + current virtual tools catalog
 *   context.edit-text  {messageIndex,blockIndex,text}
 *   context.rollback   {messageIndex}
 *   context.pop        {}
 *   context.delete     {messageIndexes:number[]} remove selected messages
 *   tool.call          {name,args}                run one registered tool directly
 *
 * Server → client:
 *   hello              {agent, history, catalog, projects, scope, group, canManageProjects}
 *   projects           {projects, scope, group, canManageProjects}  projects: [{name,path,url,current,pinned,groups}];
 *                      scope "all" (root URL) | "group" (`/group:<group>/`; group names it, else null) | "project"
 *                      agent snapshots carry `project` (path); name + project identify an agent
 *   project.added      {url}                     newly added project's URL
 *   project.removed    {url}                     this project is no longer served (or left the viewed group); navigate to url
 *   navigate           {url}                     open url (another project's view, `?resume=<id>` resuming a saved session there)
 *   sessions           {agents:[], recent:[]}   recent: saved sessions, each naming its `project` (multi-project views: every shown project's)
 *   agent              {agent}                    (viewed agent's snapshot refresh)
 *   context            {blocks, tools, history?}   real indexed messages; tools is a read-only virtual system block at messageIndex:-1, never stored
 *   chat.user          {message}                  (echo of a submitted user msg; message.attachments carry {name,mime,size,url?})
 *   turn.start         {status, busy}             (busy: the Agent's flag NOW)
 *   turn.delta         {kind:"text"|"thinking", text}
 *   turn.end           {history, terminal:{type,error?,kind?}, pendingCount, busy, status}
 *   tool.execute       {call}
 *   tool.data          {call, chunk}
 *   tool.result        {result, display, attachments}  file bytes omitted; images load from attachments[].url (GET media/<key>/<m>/<b>/<version>)
 *   question.open      {requestId, questions}
 *   question.close     {requestId?}               (answered elsewhere, timed out, or cancelled)
 *   command.result     {text}                     (output of a /command)
 *   command.exit       {}                         (/bye — the agent closed)
 *   settings           {safe, thinking, sessionSave?, spawnPermission, endpoint, model, models, prefs}
 *   endpoints          {endpoints:[{name,models,loginRequired}], presets:[{name,label,provider,url,oauth}], removable, policies:[{name,disabled,maxActive?,effective?,models:[{id,maxActive?,effective?}]}]}
 *   oauth              {state:"url"|"log"|"done"|"error", url?, text?}
 *   command.open       {view}                     open a client view (login, palette, context, help)
 *   command.copy       {text}                     copy text to the browser clipboard
 *   command.fill       {text}                     load text into the composer for editing (/<prompt>)
 *   error              {message}
 */

const MAX_TEXT = 1024 * 1024;
/** Validate and return a string within the supplied length limit.
 * @param {*} value Value to validate.
 * @param {string} name Field label used in errors.
 * @param {number} [max=MAX_TEXT] Maximum allowed UTF-16 code units.
 * @returns {string} The original value.
 * @throws {TypeError} If value is not a string or exceeds max.
 */
const string = (value, name, max = MAX_TEXT) => {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`invalid ${name}`);
  return value;
};
/** Require a non-null, non-array object.
 * @param {*} value Value to validate.
 * @returns {object} The original object.
 * @throws {TypeError} If value is null, not an object, or an array.
 */
const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid message");
  return value;
};
/** Validate a non-empty string field and return its trimmed value.
 * @param {*} value Value to validate.
 * @param {string} label Field label used in errors.
 * @param {number} [max=256] Maximum length passed to {@link string}.
 * @returns {string} The trimmed value.
 * @throws {TypeError} If the value is invalid or empty after trimming.
 */
const name = (value, label, max = 256) => {
  const text = string(value, label, max).trim();
  if (text === "") throw new TypeError(`invalid ${label}`);
  return text;
};
/** Require a non-negative integer.
 * @param {*} value Value to validate.
 * @param {string} name Field label used in errors.
 * @returns {number} The validated value.
 * @throws {TypeError} If value is not an integer or is negative.
 */
const integer = (value, name) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
};
/** Read the optional project path naming an agent's project.
 * @param {object} value Packet object.
 * @returns {{project?: string}} Spreadable field; empty when absent.
 * @throws {TypeError} If present but not a non-empty path string.
 */
const project = (value) => value.project === undefined ? {} : { project: name(value.project, "project", 4096) };
/** Validate a group name: it is a URL segment of the group view (`/group:<group>/`), so no `/`.
 * @param {*} value Value to validate.
 * @returns {string} The trimmed name.
 * @throws {TypeError} If empty, too long, or containing `/`.
 */
const groupName = (value) => {
  const text = name(value, "group", 64);
  if (text.includes("/")) throw new TypeError("invalid group (no /)");
  return text;
};

/** Parse an untrusted client packet into a normalized internal message.
 * Supports JSON text or bytes and validates each supported packet type.
 * @param {string|ArrayBuffer|ArrayBufferView} raw JSON text or encoded packet bytes.
 * @returns {object} Normalized packet with `type` and its validated payload.
 * @throws {TypeError} For invalid JSON, malformed fields, or unsupported packet types; callers may send a wire `error` packet.
 * @throws {TypeError} When decoding malformed bytes fails.
 */
export function parseClientMessage(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
  } catch { throw new TypeError("invalid JSON"); }
  object(value);
  const type = string(value.type, "type", 64);
  switch (type) {
    case "chat.submit": {
      const text = string(value.text, "text");
      if (value.attachments === undefined) return { type, text };
      if (!Array.isArray(value.attachments) || value.attachments.length > 10) throw new TypeError("invalid attachments");
      const attachments = value.attachments.map((id) => string(id, "attachment", 128));
      if (new Set(attachments).size !== attachments.length) throw new TypeError("invalid attachments");
      return { type, text, attachments };
    }
    case "chat.cancel": case "chat.unqueue": case "chat.continue": return { type };
    case "question.answer": {
      const requestId = string(value.requestId, "requestId", 128);
      if (value.answers !== null && !Array.isArray(value.answers)) throw new TypeError("invalid answers");
      return { type, requestId, answers: value.answers ?? null };
    }
    case "project.add": case "project.select": case "project.remove": return { type, path: name(value.path, "path", 4096) };
    case "project.pin": return { type, path: name(value.path, "path", 4096), pinned: value.pinned === true };
    case "project.group": return { type, path: name(value.path, "path", 4096), group: groupName(value.group), member: value.member === true };
    case "session.list": case "session.clear": return { type };
    case "session.new": return { type, anonymous: value.anonymous === true, safe: value.safe === true };
    case "session.add": return { type, safe: value.safe === true, ...(value.model === undefined ? {} : { model: string(value.model, "model", 256) }) };
    case "session.rename": return { type, name: name(value.name, "name"), ...(value.id === undefined ? {} : { id: string(value.id, "id", 512) }), ...project(value) };
    case "session.delete": return { type, id: string(value.id, "id", 512), ...project(value) };
    case "agent.rename": return { type, name: name(value.name, "name"), ...(value.agentId === undefined ? {} : { agentId: string(value.agentId, "agentId", 512) }), ...project(value) };
    case "session.fork": return { type, ...(value.id === undefined ? {} : { id: string(value.id, "id", 512) }) };
    case "session.switch": case "session.close": return { type, agentId: string(value.agentId, "agentId", 512), ...project(value) };
    case "session.resume": return { type, id: string(value.id, "id", 512), ...project(value) };
    case "settings.safe": return { type, on: value.on === true };
    case "settings.thinking": return { type, level: string(value.level, "level", 32) };
    case "settings.session-save": return { type, on: value.on === true };
    case "settings.model": return { type, model: string(value.model, "model", 256) };
    case "settings.spawn": return { type, value: value.value === true ? true : value.value === false ? false : null };
    case "settings.theme": return { type, name: string(value.name, "name", 128) };
    case "endpoint.list": return { type };
    case "endpoint.login": {
      if (!["package", "local"].includes(value.scope)) throw new TypeError("invalid scope");
      return {
        type, scope: value.scope, name: name(value.name, "name"), provider: name(value.provider, "provider"), url: name(value.url, "url", 2048),
        ...(value.token === undefined || value.token === "" ? {} : { token: string(value.token, "token", 8192) }),
      };
    }
    case "endpoint.oauth": case "endpoint.logout": case "mcp.oauth": return { type, name: name(value.name, "name") };
    case "endpoint.policy": {
      const change = value.change !== null && typeof value.change === "object" ? value.change : {};
      const keys = Object.keys(change);
      if (keys.length !== 1) throw new TypeError("invalid change");
      if (keys[0] === "disabled" && typeof change.disabled === "boolean") return { type, selector: name(value.selector, "selector", 1024), change: { disabled: change.disabled } };
      if (keys[0] !== "maxActive") throw new TypeError("invalid change");
      const maxActive = change.maxActive === null || change.maxActive === false ? change.maxActive : integer(change.maxActive, "maxActive");
      return { type, selector: name(value.selector, "selector", 1024), change: { maxActive } };
    }
    case "mcp.oauth-paste": return { type, input: name(value.input, "input", 8192) };
    case "endpoint.oauth-paste": return { type, input: name(value.input, "input", 8192) };
    case "context.inspect": case "context.pop": return { type };
    case "context.edit-text": return {
      type,
      messageIndex: integer(value.messageIndex, "messageIndex"),
      blockIndex: integer(value.blockIndex, "blockIndex"),
      text: string(value.text, "text"),
    };
    case "context.rollback": return { type, messageIndex: integer(value.messageIndex, "messageIndex") };
    case "context.delete": {
      if (!Array.isArray(value.messageIndexes) || value.messageIndexes.length === 0) throw new TypeError("invalid messageIndexes");
      return { type, messageIndexes: [...new Set(value.messageIndexes.map((index) => integer(index, "messageIndex")))].sort((a, b) => a - b) };
    }
    case "tool.call": return { type, name: string(value.name, "name", 256), args: value.args ?? {} };
    default: throw new TypeError("unsupported message type");
  }
}
