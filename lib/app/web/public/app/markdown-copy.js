/** Markdown DOM rendering, source tracking, native copy and clipboard fallback. */
import { el, button, toast } from "./dom.js";
import { renderMarkdown } from "../markdown.js";
import { selectionMarkdown } from "../copy-markdown.js";
import { installMarkdownCopy } from "./logic/copy.js";
const markdownSources = new WeakMap();
/**
 * Render Markdown source into an element, remembering the source for
 * Markdown-preserving copy and adding a copy bar to fenced code blocks.
 * @param {string} tag - element tag.
 * @param {string} className
 * @param {*} source - Markdown source.
 * @returns {HTMLElement}
 */
function markdownNode(tag, className, source) {
  const node = el(tag, className);
  updateMarkdownNode(node, source);
  return node;
}

/**
 * Update Markdown inside a mounted container, including its copy source.
 * @param {HTMLElement} node - retained Markdown container.
 * @param {*} source - Markdown source.
 * @returns {void}
 */
function updateMarkdownNode(node, source) {
  node.innerHTML = renderMarkdown(source);
  markdownSources.set(node, String(source ?? ""));
  for (const pre of node.querySelectorAll("pre.md-code")) {
    const bar = el("div", "code-bar");
    bar.append(el("span", "code-lang", pre.dataset.lang || "text"), button("code-copy", "Copy", (event) => { event.stopPropagation(); copyText(pre.querySelector("code")?.textContent ?? "", "Code copied"); }));
    pre.prepend(bar);
  }
}


// Native select+copy keeps the browser's visible selection and writes the
// matching raw Markdown instead of flattening headings, links or emphasis.
function installCopyListener() {
  installMarkdownCopy(document, () => window.getSelection(), (range) => selectionMarkdown(range, (node) => markdownSources.get(node)));
}

/**
 * Copy text to the clipboard and toast the result.
 * @param {*} text
 * @param {string} [message="Copied"] - success toast text.
 * @returns {Promise<void>}
 * Errors: falls back to a hidden-selection `execCommand("copy")` when the
 * Clipboard API is unavailable (insecure context or older browser).
 */
async function copyText(text, message = "Copied") {
  try { await navigator.clipboard.writeText(String(text)); toast(message); }
  catch {
    // Clipboard API needs a secure context; loopback http normally is one,
    // but fall back to a hidden selection for older browsers.
    const area = el("textarea"); area.value = String(text); area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select();
    const ok = document.execCommand?.("copy"); area.remove();
    toast(ok ? message : "Could not copy", !ok);
  }
}


export { markdownSources, markdownNode, updateMarkdownNode, installCopyListener, copyText };
