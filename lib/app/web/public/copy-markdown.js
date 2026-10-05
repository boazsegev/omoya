/**
 * Map a rendered-text selection to its corresponding original Markdown source.
 * Rendered parts that do not occur in the source (e.g. typeset math) are tolerated
 * until the selection touches one; selecting the entire rendered text always returns
 * the complete source, and a selection reaching either edge keeps that edge's hidden syntax.
 * @param {string} source Original Markdown source.
 * @param {string[]} parts Rendered text parts, in document order.
 * @param {number} start Inclusive start offset in concatenated rendered text.
 * @param {number} end Exclusive end offset in concatenated rendered text.
 * @returns {string|null} Source substring, whole source, or `null` when the selection is empty or touches unmapped text.
 */
export function sourceRangeForText(source, parts, start, end) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  // Selecting the whole rendered block copies the whole source, including
  // leading/trailing syntax that has no visible text (fences, link URL, etc.).
  if (start <= 0 && end >= total && total > 0) return source;
  let rendered = 0;
  let cursor = 0;
  let from = null;
  let to = null;
  for (const part of parts) {
    const [index, width] = partSpan(source, part, cursor);
    const next = rendered + part.length;
    if (start < next && end > rendered) {
      if (index < 0) return null; // Selected display-only text: leave native copy alone.
      const a = index + Math.min(width, Math.max(0, start - rendered));
      const b = index + Math.min(width, end - rendered);
      if (from === null) from = a;
      to = b;
    }
    rendered = next;
    if (index >= 0) cursor = index + width;
  }
  if (from === null) return null;
  // A selection running past either edge keeps that edge's hidden syntax (heading marks, fences).
  const text = source.slice(start <= 0 ? 0 : from, end >= total ? source.length : to);
  return text === '' ? null : text; // only block formatting selected: native copy
}

/**
 * Where a rendered part sits in the source, searching from `cursor`. Whitespace-only
 * parts include the renderer's formatting between block tags (`<ul>\n<li>`), which
 * the source need not hold at that point: one maps only when nothing but syntax
 * (no letters or digits) lies before its match, else it is a zero-width point at
 * `cursor` — searching further would skip the text that follows it.
 * @returns {[number, number]} source index (-1 for display-only text) and mapped width.
 */
function partSpan(source, part, cursor) {
  const index = source.indexOf(part, cursor);
  if (part.trim() !== '' || (index >= 0 && !/[\p{L}\p{N}]/u.test(source.slice(cursor, index)))) return [index, part.length];
  return [cursor, 0];
}

/**
 * Map the part of a DOM selection inside one rendered Markdown root back to source text.
 * The range is clipped to the root; injected `.code-bar` text is ignored.
 * @param {Element} root Rendered Markdown content root.
 * @param {string} source Original Markdown source.
 * @param {Range} range DOM range representing the selection.
 * @returns {string|null} Corresponding source substring or `null` when unmappable.
 * @effects Reads the DOM and creates detached range/content clones; does not modify the live selection.
 */
export function selectedMarkdown(root, source, range) {
  const clip = clipRange(range, root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    // The injected Copy control in a code fence is not part of the Markdown.
    if (!text.parentElement?.closest('.code-bar')) parts.push(text.textContent ?? '');
  }
  // DOM text offsets include the code bar; subtract its text in a clone of
  // each prefix rather than changing the live selection or its focus.
  const offset = (container, at) => {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(container, at);
    const fragment = prefix.cloneContents();
    for (const bar of fragment.querySelectorAll('.code-bar')) bar.remove();
    return fragment.textContent.length;
  };
  return sourceRangeForText(source, parts, offset(clip.startContainer, clip.startOffset), offset(clip.endContainer, clip.endOffset));
}

/**
 * Markdown for a whole selection: the source behind the one rendered root that
 * contains it, or, across several roots (e.g. many messages), each root's mapped
 * source joined by blank lines. Display chrome outside the roots and roots that are
 * not rendered (collapsed cards) are dropped, as native copy would; a
 * root that cannot be mapped contributes its rendered text.
 * @param {Range} range DOM range representing the selection.
 * @param {(node: Node) => string|undefined} sourceOf Markdown source of a rendered root, else undefined.
 * @returns {string|null} Text to copy, or `null` to keep the native copy.
 */
export function selectionMarkdown(range, sourceOf) {
  for (let node = range.commonAncestorContainer; node; node = node.parentNode) {
    const source = sourceOf(node);
    if (source !== undefined) return selectedMarkdown(node, source, range);
  }
  const roots = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => !range.intersectsNode(node) || node.checkVisibility?.() === false ? NodeFilter.FILTER_REJECT
      : sourceOf(node) !== undefined ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!roots.some((root) => root.contains(node))) roots.push(node);
  const texts = roots.map((root) => selectedMarkdown(root, sourceOf(root), range) ?? clipRange(range, root).toString()).filter(Boolean);
  return texts.length ? texts.join('\n\n') : null;
}

/** @returns {Range} a copy of `range` limited to `root`'s contents. */
function clipRange(range, root) {
  const clip = document.createRange();
  clip.selectNodeContents(root);
  if (range.compareBoundaryPoints(Range.START_TO_START, clip) > 0) clip.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clip) < 0) clip.setEnd(range.endContainer, range.endOffset);
  return clip;
}
