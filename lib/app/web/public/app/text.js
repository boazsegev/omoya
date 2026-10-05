/** Text-only display helpers shared by views and controllers. */
export function relativeTime(mtime) {
  const at = Number(mtime);
  if (!Number.isFinite(at) || at <= 0) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(at).toLocaleDateString();
}
export const shortId = (id) => (String(id).length > 18 ? `${String(id).slice(0, 8)}…` : String(id));
export function statusWord(text) {
  const node = document.createElement("span");
  node.className = "working-word";
  node.textContent = text;
  return node;
}
