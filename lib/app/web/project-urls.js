/** Project URLs: the project names (shortest unique path suffixes, as env.name) avoiding root routes; the root URL is the all-projects view. */
import { join } from "node:path";
import { pathNames } from "../../util.js";

// A project URL must not shadow a root route of the all-projects view:
// client folders, the socket/upload/media endpoints, and root asset files.
const RESERVED = new Set(["app", "markdown", "media", "upload", "ws"]);
const reserved = (segment) => RESERVED.has(segment.toLowerCase()) || /\.(js|css|html|svg)$/i.test(segment);

/** Expand only the server user's home shorthand, not other users' homes. */
export function expandProjectPath(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Map project paths to shortest unique URLs that avoid reserved root routes.
 * @param {string[]} paths - Served project paths, startup first.
 * @returns {Map<string, string>} path -> `/suffix/` URL.
 * @throws {TypeError} When a path has no unreserved unique suffix (the root folder included).
 */
export function projectUrls(paths) {
  const urls = new Map();
  for (const [path, segments] of pathNames(paths, reserved)) {
    if (segments.length === 1 && segments[0] === path) throw new TypeError(`no unique project URL for ${path}`);
    urls.set(path, `/${segments.map(encodeURIComponent).join("/")}/`);
  }
  return urls;
}
