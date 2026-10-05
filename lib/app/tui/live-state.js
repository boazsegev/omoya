/** live-state: Per-agent stream, timing, transcript and viewer catalog state. */
import { effect } from "../gtui/gtui.js";
import Markdown from "../markdown/index.js";
const { BashSanitizer } = Markdown;
import { createTranscriptProjector } from "./transcript.js";
import { contextBlocks } from "./context-blocks.js";
import { filterViewerBlocks } from "./overlay-controller.js";
import { toolCatalogText } from "../shared/tool-catalog.js";

export function createLiveState(slot, viewed, previewRows) {
  // Running state and live previews belong to REAL agents, never the viewed
  // slot. A switch therefore neither cancels nor hides another session's work.
  const activeTurns = new Set();
  const closedAgents = new WeakSet();
  // Reseat closes the replaced Agent before moving the slot. Its close event
  // can dispatch during that narrow interval, when the old Agent still looks
  // current; it must not disable the fresh session's draft.
  const reseatingAgents = new WeakSet();
  const liveByOrigin = new WeakMap();
  /** Slot-switch hook: once the CLOSE_MARKED promise (the UI holds the
   *  agent until navigation) resolves, drop app-owned per-agent state.
   * @param {object} _next - the agent being switched to (unused)
   * @param {object} prev - the agent being switched away from */
  slot.onSwitch((_next, prev) => {
    // CLOSE_MARKED promised that the UI is the final holder until navigation.
    // Drop app-owned per-agent state as soon as that navigation occurs.
    if (closedAgents.has(prev)) {
      activeTurns.delete(prev);
      liveByOrigin.delete(prev);
      toolStreams.delete(prev);
    }
  });
  // Live tool OUTPUT per origin (a running bash command's streamed
  // lines): bounded to the tail, cleared when the turn settles —
  // display-only, never part of the context.
  const TOOL_STREAM_LIMIT = 200;
  const toolStreams = new WeakMap();
  // One streaming sanitizer PER TOOL CALL (origin × callId): the look-back
  // buffer that catches escape sequences split across chunks must never be
  // shared between concurrent calls. Untrusted chunks are sanitized at
  // this ingest boundary; the Agent's persisted result stays byte-exact.
  const toolSanitizers = new WeakMap();
  /** Get (or lazily create) the streaming sanitizer for one tool call.
   * @param {object} origin - the Agent that owns the call
   * @param {*} callId - the call identifier (defaults to "tool")
   * @returns {object} a BashSanitizer private to (origin, callId) */
  const toolSanitizerFor = (origin, callId) => {
    let byCall = toolSanitizers.get(origin);
    if (byCall === undefined) { byCall = new Map(); toolSanitizers.set(origin, byCall); }
    const key = String(callId ?? "tool");
    let sanitizer = byCall.get(key);
    if (sanitizer === undefined) { sanitizer = new BashSanitizer({ markdown: true }); byCall.set(key, sanitizer); }
    return sanitizer;
  };
  /** Drop a finished call's sanitizer (and the origin's map once empty).
   * @param {object} origin - the Agent that owned the call
   * @param {*} callId - the finished call's identifier */
  const dropToolSanitizer = (origin, callId) => {
    const byCall = toolSanitizers.get(origin);
    if (byCall === undefined) return;
    byCall.delete(String(callId ?? "tool"));
    if (byCall.size === 0) toolSanitizers.delete(origin);
  };
  // Start/end times (display-only, like the streams above): how long each
  // tool call ran ("call:<callId>") and each reasoning block streamed
  // ("thinking:<agent>:<message>:<content index>"). Bounded to the most
  // recent entries; a resumed session simply shows no durations.
  const TIMING_LIMIT = 512;
  const timings = new Map();
  const agentSerials = new WeakMap();
  let nextAgentSerial = 0;
  /** Timing key for a thinking block: "thinking:<agent serial>:<message>:<content>".
   * @param {object} origin - the Agent (assigned a stable serial on first use)
   * @param {number} messageIndex - index of the message in the context
   * @param {number} contentIndex - index of the content part within the message
   * @returns {string} the timings-map key */
  const thinkingKey = (origin, messageIndex, contentIndex) => {
    if (!agentSerials.has(origin)) agentSerials.set(origin, nextAgentSerial++);
    return `thinking:${agentSerials.get(origin)}:${messageIndex}:${contentIndex}`;
  };
  /** Stamp one edge (start/end) of a timed span, evicting the oldest entry
   *  beyond TIMING_LIMIT; an existing stamp is preserved via re-insertion.
   * @param {string} key - a timings key ("call:<callId>" or thinkingKey(...))
   * @param {string} field - "started" or "ended" */
  const noteTime = (key, field) => {
    const times = timings.get(key) ?? {};
    timings.delete(key);
    timings.set(key, { ...times, [field]: Date.now() });
    if (timings.size > TIMING_LIMIT) timings.delete(timings.keys().next().value);
  };
  /** Mark an Agent as running a turn: future submits queue instead of
   *  starting a second task. Idempotent (Set semantics).
   * @param {object} origin - the Agent whose turn is being claimed
   * @returns {Set} the active-turns set */
  const claimTurn = (origin) => activeTurns.add(origin);
  /** Elapsed milliseconds for a fully stamped span.
   * @param {string} key - a timings key
   * @returns {?number} ended - started, or undefined until both edges exist */
  const durationOf = (key) => {
    const times = timings.get(key);
    return times?.started !== undefined && times.ended !== undefined ? times.ended - times.started : undefined;
  };
  /** Get (or lazily create) an origin's live tool-output line buffer.
   * @param {object} origin - the Agent streaming tool output
   * @returns {Array<object>} its mutable line array */
  const toolStreamFor = (origin) => {
    let lines = toolStreams.get(origin);
    if (lines === undefined) { lines = []; toolStreams.set(origin, lines); }
    return lines;
  };
  /** Whether the CURRENTLY VIEWED agent has a claimed, unsettled turn.
   * @returns {boolean} */
  const viewedRunning = () => activeTurns.has(slot.current());
  /** Re-attach the viewed agent's saved live preview/running state to a
   *  model after a session switch (per-origin state outlives the view).
   * @param {object} model - the app model
   * @returns {object} a copy with turnRunning/pendingCount/live* refreshed */
  const attachViewedLive = (model) => {
    const origin = slot.current();
    const saved = liveByOrigin.get(origin);
    return { ...model, turnRunning: viewedRunning(), pendingCount: origin.pending?.length ?? 0,
      live: saved?.live ?? null, liveOrigin: saved ? origin : null,
      liveContextLength: saved?.contextLength ?? null };
  };
  let projector = createTranscriptProjector({ previewRows });
  let projectedAgent = null;
  let projectedContext = null;
  let feedSerial = 0;
  let feedId = "transcript:0";
  const projection = { get projector() { return projector; }, get feedId() { return feedId; } };
  /** Rebuild the transcript projector (and bump the feed id) when the
   *  viewed Agent or its Context instance changes; a no-op otherwise. */
  const refreshProjection = () => {
    const real = slot.current();
    if (real !== projectedAgent || real.context !== projectedContext) {
      projectedAgent = real;
      projectedContext = real.context;
      projector = createTranscriptProjector({ previewRows });
      feedId = `transcript:${++feedSerial}`;
    }
  };
  /** "provider/model" identity text, ALWAYS read live off the viewed
   *  agent — a session switch must never show a stale combo. */
  const combo = () => viewed.model ?? "(none)/(none)";
  /** All transcript blocks for the viewed session: context messages plus
   *  the live preview and tool stream, with known durations stamped on.
   * @param {object} model - the app model (live/toolStream are read)
   * @returns {Array<object>} blocks in transcript order */
  const allBlocksFor = (model) => {
    const live = model.live && model.liveOrigin === slot.current() && viewed.context.length <= (model.liveContextLength ?? Infinity)
      ? model.live.message() : null;
    // Tool output is an open, display-only transcript projection. It never
    // enters Context: the Agent appends the authoritative final result.
    const blocks = contextBlocks(viewed.context.messages(), live, model.toolStream);
    for (const block of blocks) {
      const key = block.type === "toolcall" && block.callId !== undefined ? `call:${block.callId}`
        : block.type === "thinking" ? thinkingKey(slot.current(), block.message, block.contentIndex) : null;
      const duration = key === null ? undefined : durationOf(key);
      if (duration !== undefined) block.duration = duration;
    }
    return blocks;
  };
  /** The viewer sub-state, unwrapping a viewer-filter overlay to its inner
   *  viewer so filtering keeps the underlying selection visible.
   * @param {object} model - the app model
   * @returns {?object} the viewer state, or null when no viewer is open */
  const viewerState = (model) => model.overlay?.type === "viewer-filter" ? model.overlay.viewer : model.overlay;
  /** The transcript blocks after the viewer's type/search filters.
   * @param {object} model - the app model
   * @returns {Array<object>} the filtered blocks */
  const blocksFor = (model) => filterViewerBlocks([toolCatalogBlock(model), ...allBlocksFor(model)], viewerState(model));
  let toolCatalogRequest = 0;
  const catalogMatches = (catalog) => catalog?.agent === slot.current() && catalog.selector === viewed.model && catalog.safe === viewed.safe;
  function toolCatalogBlock(model) {
    const text = catalogMatches(model.toolCatalog) ? model.toolCatalog.text : "Loading published tools…";
    return { type: "system", category: "system", label: "Tools", virtual: true, message: -1, group: "published-tools", open: false, text };
  }
  function refreshToolCatalog(model) {
    const agent = slot.current();
    const catalog = { agent, selector: agent.model, safe: agent.safe, request: ++toolCatalogRequest, text: "Loading published tools…" };
    const task = effect.task("viewer.tools", async ({ send, signal }) => {
      let text;
      try { text = toolCatalogText(await agent.tools ?? new Map()); }
      catch (error) { text = `Unable to load published tools: ${error?.message ?? error}`; }
      if (!signal.aborted) send({ type: "viewer.tools.ready", request: catalog.request, text });
    });
    return { model: { ...model, toolCatalog: catalog }, effects: [task] };
  }

  return { activeTurns, closedAgents, reseatingAgents, liveByOrigin, toolStreams, TOOL_STREAM_LIMIT, toolSanitizerFor, dropToolSanitizer, thinkingKey, noteTime, claimTurn, durationOf, toolStreamFor, viewedRunning, attachViewedLive, refreshProjection, allBlocksFor, blocksFor, catalogMatches, refreshToolCatalog, projection };
}
