import Context from "../context.js";

const { ContentType, mimeOf } = Context;

/** Known text-only capability is authoritative; absent metadata is not a denial. */
export function modelHasNoImageInput(aiio) {
  const model = aiio?.modelCurrent?.slice(aiio.modelCurrent.indexOf("/") + 1);
  const input = aiio?.settings?.models?.[model]?.input;
  return Array.isArray(input) && input.length > 0 && !input.some((mode) => mode === "image" || mode === "vision");
}

/** Replace images the chosen model cannot consume, without changing Context. */
export function visibleResultBlocks(message, aiio) {
  if (!modelHasNoImageInput(aiio)) return message.content ?? [];
  return (message.content ?? []).map((block) => {
    if (!isImage(block)) return block;
    const mime = mimeOf(block) ?? "image/png";
    const bytes = typeof block.content === "string" ? Buffer.from(block.content, "base64").length : 0;
    return { type: ContentType.Text, text: `[image: ${mime}, ${bytes} bytes — not sent: model has no image input]` };
  });
}

/** Images include image-typed blocks and binary blocks with image media types. */
export function isImage(block) {
  return block?.type === ContentType.Image ||
    (block?.type === ContentType.Binary && String(mimeOf(block) ?? "").startsWith("image/"));
}

/** Replace only tool-result image blocks on the wire; leave stored context unchanged. */
export function visibleToolResults(context, aiio) {
  if (!modelHasNoImageInput(aiio)) return context;
  return context.map((message) => message?.type === Context.MessageType.ToolResult
    ? { ...message, content: visibleResultBlocks(message, aiio) } : message);
}

