/** Browser DOM primitives shared by independent views. */
export const SVG_NS = "http://www.w3.org/2000/svg";
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(className, label, onClick, { title, icon, type = "button" } = {}) {
  const node = el("button", className);
  node.type = type;
  if (icon) node.append(el("span", "icon", icon));
  if (label !== undefined && label !== null) node.append(icon ? el("span", "label", label) : document.createTextNode(label));
  if (title) { node.title = title; if (!label) node.setAttribute("aria-label", title); }
  if (onClick) node.addEventListener("click", onClick);
  return node;
}
export function kbd(text) { return el("kbd", null, text); }
export function toast(text, isError = false) {
  const node = el("div", "toast" + (isError ? " toast-error" : ""), String(text));
  node.addEventListener("click", () => node.remove());
  document.querySelector(isError ? "#error-region" : "#toast-region")?.append(node);
  setTimeout(() => node.remove(), isError ? 8000 : 3500);
}
