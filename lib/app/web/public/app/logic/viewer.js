/** Flatten context blocks and prepend the virtual published-tools system block. */
export function contextEntries(blocks, contextTools) {
  const stored = blocks.flatMap((message) => (message.content ?? []).map((block) => ({ ...block, source: block.text ?? JSON.stringify(block.data, null, 2) })));
  const tools = contextTools ?? { messageIndex: -1, blockIndex: 0, viewerType: "system", name: "Tools", virtual: true, text: "Loading published tools…" };
  return [{ ...tools, source: tools.text }, ...stored];
}

/** Identify the block's editable context location or its virtual origin. */
export function viewerWhere(block, all) {
  if (block.virtual) return "virtual system block";
  const parts = all.filter((entry) => entry.messageIndex === block.messageIndex).length;
  return parts > 1 ? `${block.messageIndex + 1}.${block.blockIndex + 1}` : `message ${block.messageIndex + 1}`;
}

/** Virtual catalog entries never offer context mutations. */
export function canEditViewerBlock(block) {
  return !block.virtual && typeof block.text === "string" && block.viewerType !== "tool display";
}
