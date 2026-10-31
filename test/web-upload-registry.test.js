import { expect, test } from "bun:test";
import { UploadRegistry } from "../lib/app/web/upload-registry.js";

test("an open browser connection can upload after the pending-file TTL", async () => {
  const uploads = new UploadRegistry({ ttlMs: 100 });
  const key = uploads.open();
  uploads.sweep(Date.now() + 101);
  expect(uploads.owns(key)).toBe(true);
  const file = uploads.add(key, new File(["hello"], "hello.txt"));
  const [result] = await uploads.take(key, [file.id]);
  expect(result.name).toBe("hello.txt");
  expect(new TextDecoder().decode(result.bytes)).toBe("hello");
});

test("expired pending files release capacity without invalidating the connection", async () => {
  const uploads = new UploadRegistry({ ttlMs: 100, files: 1, totalBytes: 5 });
  const key = uploads.open();
  const old = uploads.add(key, new File(["hello"], "old.txt"));
  uploads.sweep(Date.now() + 101);
  expect(uploads.owns(key)).toBe(true);
  expect(() => uploads.add(key, new File(["hello"], "new.txt"))).not.toThrow();
  await expect(uploads.take(key, [old.id])).rejects.toThrow("unknown attachment");
});

test("closing the browser connection invalidates its upload key", () => {
  const uploads = new UploadRegistry();
  const key = uploads.open();
  uploads.close(key);
  expect(uploads.owns(key)).toBe(false);
  expect(() => uploads.add(key, new File(["hello"], "hello.txt"))).toThrow("upload session expired");
});
