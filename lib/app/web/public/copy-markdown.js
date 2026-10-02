/**
 * Map a rendered-text selection to its corresponding original Markdown source.
 * Returns `null` if any rendered part cannot be mapped or the selection overlaps no part;
 * selecting the entire rendered text returns the complete source, including hidden syntax.
 * @param {string} source Original Markdown source.
 * @param {string[]} parts Rendered text parts, in document order.
 * @param {number} start Inclusive start offset in concatenated rendered text.
 * @param {number} end Exclusive end offset in concatenated rendered text.
 * @returns {string|null} Corresponding source substring, whole source, or `null` if unmappable.
 */
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

/**
 * Map a DOM selection within a rendered Markdown root back to source text.
 * Ignores injected `.code-bar` text and returns `null` when either selection endpoint
 * is outside the root or the rendered text cannot be mapped to the source.
 * @param {Element} root Rendered Markdown content root.
 * @param {string} source Original Markdown source.
 * @param {Range} range DOM range representing the selection.
 * @returns {string|null} Corresponding source substring or `null` when unavailable.
 * @throws {DOMException} If the range cannot be cloned or adjusted against the root.
 * @effects Reads the DOM and creates detached range/content clones; does not modify the live selection.
 */
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
