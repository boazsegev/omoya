// test/cli-ai-alias.test.js — the bare prefix is the app's own command,
// a transparent unprefixed form alongside the namespace-prefixed `app`
// wrapper (both are generated shims over bin/scripts/app). Every name
// derives from bin-names.js: a rename must never break this contract.
import { describe, expect, test } from "bun:test";
import { wrapperNames } from "../bin/scripts/index.js";
import { binName, cli } from "./bin-names.js";

async function run(command, args, env = process.env) {
  const proc = Bun.spawn(["bun", command, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exit };
}

const help = (command) => run(command, ["--help"]);

describe("CLI names", () => {
  test("the generated and package command lists contain only the full and short interactive names", async () => {
    const names = wrapperNames().sort();
    const packageNames = Object.keys(JSON.parse(await Bun.file("package.json").text()).bin).sort();
    expect(names).toContain("omoya");
    expect(names).toContain("om");
    expect(names).not.toContain("omi");
    expect(packageNames).toEqual(names);
  });

  test("the prefixed tui wrapper is primary and the alias preserves an invocation-aware short form", async () => {
    const [primary, alias] = await Promise.all([help(cli.app), help(cli.appAlias)]);

    expect(primary.exit).toBe(0);
    expect(primary.stderr).toBe("");
    expect(primary.stdout).toContain(`usage: ${binName("app")} `);
    expect(alias.exit).toBe(0);
    expect(alias.stderr).toBe("");
    expect(alias.stdout).toContain(`usage: ${cli.appAlias.split("/").pop()} `);
    expect(primary.stdout).toContain("--list");
  });

});
