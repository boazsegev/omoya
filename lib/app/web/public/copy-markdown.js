/** Map a selection in rendered Markdown back to its original source. */
export function sourceRangeForText(source, parts, start, end) {
  let rendered = 0;
  let cursor = 0;
  let from = null;
  let to = null;
  for (const part of parts) {
    const index = source.indexOf(part, cursor);
    if (index < 0) return null; // Unmapped rendering (e.g. typeset math): leave native copy alone.
    const next = rendered + part.length;
    if (start < next && end > rendered) {
      const a = index + Math.max(0, start - rendered);
      const b = index + Math.min(part.length, end - rendered);
      if (from === null) from = a;
      to = b;
    }
    rendered = next;
    cursor = index + part.length;
  }
  if (from === null) return null;
  // Selecting the whole rendered block should copy the whole source, including
  // leading/trailing syntax that has no visible text (fences, link URL, etc.).
  if (start === 0 && end === rendered) return source;
  return source.slice(from, to);
}

/** Return source text only when both selection ends belong to this content root. */
export function selectedMarkdown(root, source, range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let text = walker.nextNode();
  while (text) {
    // The injected Copy control in a code fence is not part of the Markdown.
    if (!text.parentElement?.closest('.code-bar')) parts.push(text.textContent ?? '');
    text = walker.nextNode();
  }
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const through = range.cloneRange();
  through.selectNodeContents(root);
  through.setEnd(range.endContainer, range.endOffset);
  // DOM text offsets include the code bar; subtract its text in a clone of
  // each prefix rather than changing the live selection or its focus.
  const offset = (prefix) => {
    const fragment = prefix.cloneContents();
    for (const bar of fragment.querySelectorAll('.code-bar')) bar.remove();
    return fragment.textContent.length;
  };
  return sourceRangeForText(source, parts, offset(before), offset(through));
}
