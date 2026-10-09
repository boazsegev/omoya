import "../child-isolation.js";
import { performanceCaseDispatch } from "../performance-process.js";
import assert from "node:assert/strict";

await performanceCaseDispatch({ assertion: () => {
  process.stdout.write("diagnostic stdout\n");
  assert.equal(1, 2, "boundary assertion reached");
} });
