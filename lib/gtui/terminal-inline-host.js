import { createInlineRenderer, bufferRows } from "./inline-render.js";
import { sceneBuffer, sceneHasAnimations } from "./scene-buffer.js";
import { layoutView, measureView } from "./layout.js";
import { DISABLE_MOUSE, ENABLE_MOUSE } from "./term.js";

function transform(root, visitFeed, retainFeeds = false) {
  if (!root || typeof root !== "object") return root;
  if (root.type === "feed") return { ...root, items: visitFeed(root.items ?? [], { retain: retainFeeds }) };
  if (!root.children) return root;
  const retain = retainFeeds || (root.type === "scroll" && root.anchor === "end" && Number(root.offset ?? 0) > 0);
  return { ...root, children: root.children.map((child) => transform(child, visitFeed, retain)) };
}

function wantsPointer(root, policy = "overlays") {
  if (!root || policy === "off") return false;
  if (root.type === "overlay") return true;
  // "overlays": only genuinely clickable transient UI (the completion
  // popup) claims the mouse outside an overlay — terminal-native
  // selection/scroll stay available everywhere else.
  if (root.type === "input" && (root.completions?.length ?? 0) > 0) return true;
  // "always": every registered control surface (input caret/drag,
  // completion click) plus managed source-range drag selection is
  // interactive — matching the alt host, which enables reporting for
  // the whole session under the same policy.
  if (policy === "always" && root.type === "input") return true;
  if (policy === "always" && root.type === "text" && root.selectionKey && root.sourceText !== undefined) return true;
  if (root.type === "feed") return (root.items ?? []).some((item) => wantsPointer(item.node, policy));
  return (root.children ?? []).some((child) => wantsPointer(child, policy));
}

function feeds(root, retain = false, output = []) {
  if (!root || typeof root !== "object") return output;
  if (root.type === "feed") {
    // Anonymous view values are commonly reconstructed each frame. Their
    // structural preorder path is stable for a stable root shape and avoids
    // retaining transient node identities forever.
    output.push({ id: root.id ?? `feed:${output.length}`, items: root.items ?? [], retain });
    return output;
  }
  const nextRetain = retain || (root.type === "scroll" && root.anchor === "end" && Number(root.offset ?? 0) > 0);
  for (const child of root.children ?? []) feeds(child, nextRetain, output);
  return output;
}

// Feed nodes are immutable view values in normal use. A supplied revision is
// authoritative; otherwise the semantic node is the revision. This is only a
// change detector, never a serialization protocol exposed to applications.
const nodeRevisions = new WeakMap();
function deeplyFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value) || seen.has(value)) return seen.has(value);
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => "value" in item && deeplyFrozen(item.value, seen));
}
function revision(item) {
  if (item.revision !== undefined) return `revision:${String(item.revision)}`;
  if (item.node && typeof item.node === "object") {
    // A frozen node can never mutate, so its deep-frozen verdict and JSON
    // fingerprint are computed once and trusted afterwards (previously the
    // deep walk re-ran for every cached node on every frame).
    const cached = nodeRevisions.get(item.node);
    if (cached?.frozen === true) return cached.value;
    let value;
    try { value = JSON.stringify(item.node); } catch { value = String(item.node); }
    nodeRevisions.set(item.node, { value, frozen: deeplyFrozen(item.node) });
    return value;
  }
  return String(item.node);
}

/** An order-sensitive fingerprint of a painted row prefix. Committed-prefix
 *  change detection hashes the prefix instead of RETAINING every committed
 *  item's painted rows forever (native scrollback owns the bytes after the
 *  commit; the host only needs to know whether they would differ). */
function hashRows(rows, end) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < end; index++) {
    const row = rows[index];
    for (let at = 0; at < row.length; at++) {
      const code = row.charCodeAt(at);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 31) + code) >>> 0;
    }
    h1 = Math.imul(h1 ^ 10, 0x01000193) >>> 0; // the row boundary
    h2 = (Math.imul(h2, 31) + 10) >>> 0;
  }
  return `${end}:${h1.toString(36)}:${h2.toString(36)}`;
}

function rowsFor(node, width, theme, controls, height, time = Date.now(), verticalAlign = "start") {
  // Completed feed items used to allocate and scan a 4096-row canvas
  // EACH, turning a 10-message resumed session into a ~10 second
  // synchronous startup. Measure first and allocate only the rows the
  // item can actually render; the live viewport still supplies its
  // real terminal height explicitly.
  const renderHeight = height ?? Math.max(1, measureView(node, { width, height: 4096, controls, theme }).height);
  const scene = layoutView(node, { width, height: renderHeight, controls, theme, verticalAlign });
  const buffer = sceneBuffer(scene, theme, time);
  const rows = bufferRows(buffer);
  // Committed feed nodes are compact. The live region keeps its exact
  // terminal height so repaint cursor math and bottom alignment cannot
  // drift as content or animation frames change.
  if (height === undefined) while (rows.at(-1) === "") rows.pop();
  return { rows, scene };
}

/** Inline feed commit/live-tail coordinator over the relative renderer. */
export function createInlineTerminalRenderer({ write, rows, controls, mouse = "overlays" }) {
  const renderer = createInlineRenderer({ rows });
  // Per-feed committed (evicted) prefixes. The live canvas always retains
  // visible items, including done ones; only completed items above it become
  // irreversible native scrollback.
  const committed = new Map();
  let refresh = false;
  let pointer = false;
  let lastCaret = null;
  let lastScene = null;

  function animatedRegion(theme, time) {
    if (!lastScene) return { active: false, bytes: "" };
    const region = bufferRows(sceneBuffer(lastScene, theme, time));
    const cursor = lastCaret ? { row: lastCaret.row + 1, col: lastCaret.column + 1 } : null;
    return {
      active: sceneHasAnimations(lastScene, theme),
      bytes: renderer.paint({ commit: [], region, cursor }),
    };
  }

  function render(root, theme, { width, height }, time = Date.now()) {
    // Never print into the terminal's final column in inline mode: a
    // pending autowrap inserts a physical row that relative repaint math
    // cannot observe, which was why animation frames leaked into scrollback.
    const renderWidth = Math.max(1, width - 1);
    // Keep an under-full inline canvas only as tall as its content. Reserving
    // the whole terminal would put invisible rows between native scrollback
    // and the live region, and growing content would scroll those blanks into
    // history. Overflow still receives the full physical viewport.
    const contentHeight = measureView(root, { width: renderWidth, height: 4096, controls, theme }).height;
    // Overlays are explicit viewport takeovers; unlike ordinary inline output,
    // their menus/viewers need the complete terminal canvas.
    const liveHeight = root?.type === "overlay" ? height : Math.max(1, Math.min(height, contentHeight));
    // Layout the actual root first. It tells us, at terminal-sized geometry,
    // which feed keys remain visible; no arbitrary app-specific transcript
    // inspection is needed.
    let { rows: region, scene } = rowsFor(root, renderWidth, theme, controls, liveHeight, time);
    const commitNodes = [];
    let rebuild = refresh;
    // Painted rows of evicted items rendered THIS frame, reused by the
    // rebuild branch below so a refresh never lays the same item out twice.
    const frameRows = new Map();
    const rootFeeds = feeds(root);
    for (const feed of rootFeeds) {
      const visibility = scene.feedVisible.get(feed.id);
      const evictedAbove = visibility?.evictedAbove ?? new Set();
      const overflowAbove = visibility?.overflowAbove ?? new Set();
      const prior = committed.get(feed.id) ?? new Map();
      const next = new Map();
      let prefixOpen = true;
      for (const item of feed.items) {
        const priorState = prior.get(item.key);
        const priorRevision = priorState?.revision;
        const currentRevision = revision(item);
        const omitTail = overflowAbove.get(item.key) ?? 0;
        // Native history is ordered. A live/mutable predecessor makes every
        // later item non-committable even if geometry happens to evict it.
        if (!item.done && !overflowAbove.has(item.key)) prefixOpen = false;
        if (prefixOpen && !feed.retain && evictedAbove.has(item.key)) {
          // An evicted item whose content revision AND omitted tail are both
          // unchanged needs no re-layout at all: its committed prefix is
          // already native scrollback and nothing new can have appeared.
          // (Previously every evicted item was re-measured, re-laid-out and
          // re-painted on EVERY frame, and its painted rows retained.)
          if (priorState?.revision === currentRevision && priorState?.omitTail === omitTail) {
            next.set(item.key, priorState);
            continue;
          }
          const itemRows = rowsFor(item.node, renderWidth, theme, undefined, undefined, time).rows;
          frameRows.set(item.key, itemRows);
          const commitEnd = Math.max(0, itemRows.length - omitTail);
          const priorEnd = priorState?.commitEnd ?? 0;
          // A committed prefix is irreversible. Append-only streaming may add
          // rows past it; any edit within it requires the simple full refresh.
          const prefixChanged = priorState !== undefined && priorState.prefixHash !== hashRows(itemRows, priorEnd);
          if (priorRevision !== undefined && priorRevision !== currentRevision && (item.done || prefixChanged || commitEnd < priorEnd)) rebuild = true;
          next.set(item.key, { revision: currentRevision, commitEnd, omitTail, prefixHash: hashRows(itemRows, commitEnd) });
          if (priorRevision === undefined) commitNodes.push({ rows: itemRows.slice(0, commitEnd) });
          else if (!rebuild && commitEnd > priorEnd) commitNodes.push({ rows: itemRows.slice(priorEnd, commitEnd) });
        }
      }
      // Scrolling away is a reversible viewport choice, not a history
      // mutation. Keep the already committed prefix intact until tail mode
      // reports an actual revised/removed evicted item.
      if (feed.retain) { committed.set(feed.id, prior); continue; }
      if ([...prior.keys()].some((key) => !next.has(key))) rebuild = true;
      committed.set(feed.id, next);
    }
    // An overlay can intentionally hide the feed for a frame. Preserve its
    // native history in that case; an application switching feed identity
    // supplies a new feed id, which creates an independent history.
    if (rebuild) {
      // Recreate the bounded native history from the current evicted prefixes.
      // The visible root remains live, so completed tail content never vanishes.
      commitNodes.length = 0;
      for (const feed of rootFeeds) {
        const visibility = scene.feedVisible.get(feed.id);
        const evictedAbove = visibility?.evictedAbove ?? new Set();
        const overflowAbove = visibility?.overflowAbove ?? new Set();
        if (!feed.retain) {
          let prefixOpen = true;
          for (const item of feed.items) {
            if (!item.done && !overflowAbove.has(item.key)) prefixOpen = false;
            if (prefixOpen && evictedAbove.has(item.key)) {
              const itemRows = frameRows.get(item.key) ?? rowsFor(item.node, renderWidth, theme, undefined, undefined, time).rows;
              const omitTail = overflowAbove.get(item.key) ?? 0;
              commitNodes.push({ rows: itemRows.slice(0, Math.max(0, itemRows.length - omitTail)) });
            }
          }
        }
      }
    }
    // Physical history is non-interactive: do not let compact committed-node
    // layouts begin/end the shared control frame after the live root mounted it.
    const commit = commitNodes.flatMap(({ rows: committedRows }) => committedRows);
    lastScene = scene;
    lastCaret = scene.canvas.caret;
    const cursor = lastCaret ? { row: lastCaret.row + 1, col: lastCaret.column + 1 } : null;
    const nextPointer = wantsPointer(root, mouse);
    let bytes = "";
    if (nextPointer !== pointer) bytes += nextPointer ? ENABLE_MOUSE : DISABLE_MOUSE;
    pointer = nextPointer;
    bytes += rebuild ? renderer.refresh({ commit, region, cursor }) : renderer.paint({ commit, region, cursor });
    refresh = false;
    write(bytes);
    return sceneHasAnimations(scene, theme);
  }

  return {
    render,
    /** Repaint host-clock animation styles over the already laid-out live
     * region. Animation frames never remeasure the transcript/tree. */
    animate(theme, time = Date.now()) {
      const frame = animatedRegion(theme, time);
      write(frame.bytes);
      return frame.active;
    },
    get caret() { return lastCaret; },
    refresh() { refresh = true; committed.clear(); lastScene = null; },
    leave() {
      const bytes = (pointer ? DISABLE_MOUSE : "") + renderer.leave();
      pointer = false;
      lastCaret = null;
      lastScene = null;
      write(bytes);
    },
  };
}

export const inlineHostInternals = Object.freeze({ transform, wantsPointer, rowsFor });
