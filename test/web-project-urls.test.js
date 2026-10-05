import { expect, test } from "bun:test";
import { expandProjectPath, projectUrls } from "../lib/app/web/project-urls.js";

test("server home shorthand expands only bare ~ and ~/ paths", () => {
  expect(expandProjectPath("~", "/home/tester")).toBe("/home/tester");
  expect(expandProjectPath("~/x", "/home/tester")).toBe("/home/tester/x");
  expect(expandProjectPath("~other/x", "/home/tester")).toBe("~other/x");
});

test("every project, startup included, gets a suffix URL; root stays the all-projects view", () => {
  const root = "/home/user/start";
  expect([...projectUrls([root])]).toEqual([[root, "/start/"]]);
  expect([...projectUrls([root, "/a/foo"])]).toEqual([[root, "/start/"], ["/a/foo", "/foo/"]]);
  expect([...projectUrls([root, "/a/foo", "/b/foo"])]).toEqual([[root, "/start/"], ["/a/foo", "/a/foo/"], ["/b/foo", "/b/foo/"]]);
});

test("nested collisions extend only as far as needed", () => {
  const urls = projectUrls(["/start", "/fuz/bar/foo", "/fiz/bar/foo", "/fiz/else/foo"]);
  expect(urls.get("/fuz/bar/foo")).toBe("/fuz/bar/foo/");
  expect(urls.get("/fiz/bar/foo")).toBe("/fiz/bar/foo/");
  expect(urls.get("/fiz/else/foo")).toBe("/else/foo/");
});

test("URLs never start with a reserved root route", () => {
  const urls = projectUrls(["/home/me/app", "/home/me/ws", "/srv/media", "/x/app.js"]);
  expect(urls.get("/home/me/app")).toBe("/me/app/");
  expect(urls.get("/home/me/ws")).toBe("/me/ws/");
  expect(urls.get("/srv/media")).toBe("/srv/media/");
  expect(urls.get("/x/app.js")).toBe("/x/app.js/");
  expect(() => projectUrls(["/app"])).toThrow("no unique project URL");
});
