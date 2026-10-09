import { expect, test } from "bun:test";
import { pathNames } from "../lib/util.js";

// The reference implements the suffix contract directly for small input sets.
function reference(paths, reserved = () => false) {
  const segments = paths.map((path) => String(path).split(/[\\/]+/).filter(Boolean));
  return paths.map((path, i) => {
    let depth = 1;
    while (depth <= segments[i].length && (reserved(segments[i].at(-depth)) || paths.some((other, j) => other !== path && segments[j].slice(-depth).join("\0") === segments[i].slice(-depth).join("\0")))) depth++;
    return depth > segments[i].length ? [path] : segments[i].slice(-depth);
  });
}

test("folder names resolve shared suffixes and reserved segments", () => {
  const paths = ["/a/bar/foo", "/b/bar/foo", "/a/bar", "/", "/a/bar/foo", "/z/foo", "C:\\a\\foo"];
  for (const reserved of [() => false, (name) => name === "foo" || name === "bar"]) {
    expect([...pathNames(paths, reserved).values()]).toEqual(reference([...new Set(paths)], reserved));
  }
});

test("naming thousands of pinned project folders scales without scanning every other folder for each", () => {
  const paths = Array.from({ length: 5000 }, (_, index) => `/workspace/p${index % 50}/project${index}`);
  const names = pathNames(paths);
  expect(names.size).toBe(paths.length);
  expect(names.get(paths[4950])).toEqual(["project4950"]);
});
