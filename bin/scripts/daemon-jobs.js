#!/usr/bin/env bun
/** One fresh-process scan of enabled pinned projects. No long-lived imports. */
import Jobs from "../../lib/jobs.js";

const roots = process.argv.slice(2);
if (roots.length !== 1) {
  console.error("daemon jobs: expected one project folder");
  process.exitCode = 1;
} else {
  const [root] = roots;
  try {
    const result = await Jobs.run(root);
    if (result.errors.length) {
      console.error(`daemon jobs: ${root}: ${result.errors.length} problem(s)${result.log ? ` in ${result.log}` : ""}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`daemon jobs: ${root}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
