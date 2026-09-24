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
 *   question.answer    {requestId, answers|null}  resolve an open question
 *   session.list       {}
 *   session.new        {}                         replace viewed agent with a fresh session (saved by default)
 *   session.add        {}                         add a new agent (keep current)
 *   session.fork       {id?}                      fork current session into a logged branch
 *   session.switch     {agentId}
 *   session.close      {agentId}                  close one open agent
 *   session.resume     {id}                       replace viewed agent with resumed session
 *   settings.safe      {on:boolean}
 *   settings.thinking  {level}
 *   settings.session-save {on:boolean}            (anonymous agent + on:true starts a saved session)
 *   settings.model     {model:"endpoint/model"|"model"|"endpoint"}
 *   context.inspect    {}                         request structured context blocks
 *   context.edit-text  {messageIndex,blockIndex,text}
 *   context.rollback   {messageIndex}
 *   context.pop        {}
 *   context.delete     {messageIndexes:number[]} remove selected messages
 *   tool.call          {name,args}                run one registered tool directly
 *
 * Server → client:
 *   hello              {agent, history, catalog}  (catalog: commands/prompts/tools)
 *   sessions           {agents:[], recent:[]}
 *   agent              {agent}                    (viewed agent's snapshot refresh)
 *   chat.user          {message}                  (echo of a submitted user msg)
 *   turn.start         {status, busy}             (busy: the Agent's flag NOW)
 *   turn.delta         {kind:"text"|"thinking", text}
 *   turn.end           {terminal:{type,error?,kind?}, pendingCount, busy, status}
 *   tool.execute       {call}
 *   tool.data          {call, chunk}
 *   tool.result        {result, display}
 *   question.open      {requestId, questions}
 *   question.close     {}                         (the tool timed out or was cancelled)
 *   command.result     {text}                     (output of a /command)
 *   command.exit       {}                         (/bye — the agent closed)
 *   settings           {safe, thinking, sessionSave?, endpoint, model, models}
 *   error              {message}
 */

const MAX_TEXT = 1024 * 1024;
const string = (value, name, max = MAX_TEXT) => {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`invalid ${name}`);
  return value;
};
const object = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid message");
  return value;
};
const integer = (value, name) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
};

/** Parse an untrusted client packet into a normalized internal message.
 *  Throws TypeError on anything malformed — the caller turns that into a
 *  wire `error` packet. Returns {type, ...payload}. */
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
    case "chat.cancel": case "chat.unqueue": return { type };
    case "question.answer": {
      const requestId = string(value.requestId, "requestId", 128);
      if (value.answers !== null && !Array.isArray(value.answers)) throw new TypeError("invalid answers");
      return { type, requestId, answers: value.answers ?? null };
    }
    case "session.list": case "session.new": case "session.add": return { type };
    case "session.fork": return { type, ...(value.id === undefined ? {} : { id: string(value.id, "id", 512) }) };
    case "session.switch": case "session.close": return { type, agentId: string(value.agentId, "agentId", 512) };
    case "session.resume": return { type, id: string(value.id, "id", 512) };
    case "settings.safe": return { type, on: value.on === true };
    case "settings.thinking": return { type, level: string(value.level, "level", 32) };
    case "settings.session-save": return { type, on: value.on === true };
    case "settings.model": return { type, model: string(value.model, "model", 256) };
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
