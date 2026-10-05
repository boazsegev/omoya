/** A load resets the transcript only if preserving existing rows is not requested. */
export function historyScrollFlags(preserveRows) {
  return { resetTranscript: !preserveRows, stickBottom: !preserveRows };
}

/** Whether measured geometry is inside the bottom's 80px magnet area. */
export function isNearBottom(scroll) {
  return !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
}

/** Decide whether scroll jumps should be visible from measured geometry. */
export function jumpVisibility({ scrollTop, scrollHeight, clientHeight }) {
  return { topHidden: scrollTop < clientHeight, bottomHidden: isNearBottom({ scrollTop, scrollHeight, clientHeight }) };
}

/** A reset ignores incidental near-bottom measurements; a pending stick wins. */
export function shouldStickToBottom({ stickBottom, resetTranscript }, isNearBottom) {
  return stickBottom || (!resetTranscript && isNearBottom);
}

/** User messages arm a jump; incoming blocks leave scrolling to the bottom magnet. */
export function appendTranscriptBlock(state, block, touch) {
  if (block.kind === "user") state.stickBottom = true;
  state.blocks.push(block);
  touch(block);
}
