/** attachments.js — File attachment chips and image thumbnails shared by the transcript and context viewer. */
import { el } from "./dom.js";
import { formatBytes } from "../format.js";

/**
 * Render file attachments: images as thumbnails that open full size in a new
 * tab (the app stays open), other files as name chips. Bytes arrive by the
 * server's media URL only.
 * @param {Array<{name: string, size?: number, url?: string}>} files - Attachment descriptors.
 * @returns {HTMLElement} the `.attachment-chips` row.
 */
export function attachmentsNode(files) {
  const list = el("div", "attachment-chips inline");
  for (const file of files) {
    const label = `${file.name}${file.size ? ` · ${formatBytes(file.size)}` : ""}`;
    if (!file.url) { list.append(el("span", "attachment-chip", `📎 ${label}`)); continue; }
    const link = el("a", "attachment-image");
    Object.assign(link, { href: file.url, target: "_blank", rel: "noopener noreferrer", title: `${label} — open in a new tab` });
    const image = el("img");
    Object.assign(image, { src: file.url, alt: file.name, loading: "lazy", decoding: "async" });
    link.append(image);
    list.append(link);
  }
  return list;
}
