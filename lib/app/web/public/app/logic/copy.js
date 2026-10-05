/** Register Markdown-aware native copy, leaving unmappable selections to the browser. */
export function installMarkdownCopy(target, getSelection, mapSelection) {
  target.addEventListener("copy", (event) => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !event.clipboardData) return;
    const text = mapSelection(selection.getRangeAt(0));
    if (text === null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  });
}
