/** Identity of a mounted bubble; a different tool call must mount a new row. */
export function sameBubble(previous, next) {
  return previous?.kind === next.kind && previous.callId === next.callId;
}

/** Reconcile transcript rows without remounting existing bubbles. */
export function reconcileRows({ blocks, nodes, rowBlocks, container, makeFrame, patch, refresh, dirty }) {
  for (const row of nodes.splice(blocks.length)) row.remove();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const row = nodes[i];
    if (!row || !sameBubble(rowBlocks.get(row), block)) {
      const next = makeFrame(block);
      if (row) row.replaceWith(next);
      else container.append(next);
      nodes[i] = next;
    } else if (refresh || dirty.has(block)) patch(row, block);
  }
}

/** Keep mounted animated indicators while reconciling a streaming card. */
export function reconcileCardChildren(parent, children) {
  for (const child of Array.from(parent.childNodes)) if (!children.includes(child)) child.remove();
  for (let i = 0; i < children.length; i++) {
    if (parent.childNodes[i] !== children[i]) parent.insertBefore(children[i], parent.childNodes[i] ?? null);
  }
}

/** Patch streamed content, retaining the mounted icon/shimmer and summary. */
export function patchStreamingCard(row, fresh) {
  const card = row.firstElementChild;
  const summary = card.querySelector("summary");
  const nextSummary = fresh.querySelector("summary");
  const head = summary.querySelector(".card-head");
  const nextHead = nextSummary.querySelector(".card-head");
  const preserved = new Map();
  for (const selector of [".tool-state", ".shimmer-dots", ".block-kind"]) {
    const old = head.querySelector(selector);
    if (old) preserved.set(selector, old);
  }
  const fields = Array.from(nextHead.childNodes, (node) => {
    const selector = [...preserved.keys()].find((key) => node.matches?.(key));
    if (!selector) return node;
    const old = preserved.get(selector);
    if (old.textContent !== node.textContent) old.textContent = node.textContent;
    if (selector === ".tool-state") old.setAttribute("aria-label", node.getAttribute("aria-label"));
    return old;
  });
  reconcileCardChildren(head, fields);
  reconcileCardChildren(summary, [head, ...Array.from(nextSummary.childNodes).slice(1)]);
  const body = card.querySelector(".tool-body");
  const nextBody = fresh.querySelector(".tool-body");
  if (body && nextBody) body.replaceChildren(...nextBody.childNodes);
  const content = Array.from(fresh.childNodes).slice(1).map((node) => body && node === nextBody ? body : node);
  reconcileCardChildren(card, [summary, ...content]);
}
