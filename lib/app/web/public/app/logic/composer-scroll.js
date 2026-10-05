/** Resize the composer without changing the reader's transcript position. */
export function autofitComposer(textarea, scroll, firstWrite = false) {
  if (!textarea) return;
  const previousScroll = scroll?.scrollTop;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 12 * 24) + "px";
  if (!scroll) return;
  scroll.scrollTop = firstWrite ? scroll.scrollHeight : previousScroll;
}

/** Only the transition from an empty working draft is a first write. */
export function isFirstComposerWrite(previousText, currentText) {
  return !previousText && !!currentText;
}
