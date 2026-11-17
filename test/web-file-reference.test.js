import { test, expect } from "bun:test";
import { fileReference } from "../lib/app/web/public/app/logic/file-reference.js";
test("file references name each relative path once and qualify foreign projects without host paths", () => {
  expect(fileReference("README.md", "omoya", true)).toBe("`README.md`");
  expect(fileReference("docs/guide.md", "cstl", false)).toBe("`docs/guide.md`@`cstl`");
  expect(fileReference("", "cstl", false)).toBe("`.`@`cstl`");
  expect(fileReference("a`b.md", "omoya", true)).toBe("``a`b.md``");
  expect(fileReference("a`b.md", "pro`ject", false)).toBe("``a`b.md``@``pro`ject``");
});
