import "../child-isolation.js";
import { performanceCaseDispatch } from "../performance-process.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { SettingsStore } from "../../lib/env/settings-store.js";
import { Env } from "../../lib/env.js";

// Smoke tests against accidental complexity (not scheduling guarantees):
// large settings stay usable without quadratic work or long stalls.
const COUNT = 20000;
function graph(count = COUNT) {
  const providers = {};
  for (let index = 0; index < count; index++) providers[`ep${index}`] = { url: `u${index}`, models: { m: { context: 1000 } } };
  return { providers };
}
function call(fn) { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; }
function below(value, threshold, label) { assert.ok(value < threshold, `${label}: ${value}ms >= ${threshold}ms`); }
async function heartbeat(fn) {
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 1);
  try {
    const result = await fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { result, gap };
  } finally { clearInterval(timer); }
}

async function memory() {
  const data = graph();
  const store = new SettingsStore({ sources: [{ data }] });
  const upper = store.attach({ data: { providers: { ep0: { disabled: true } } } });
  try {
    const cold = call(() => store.read());
    below(cold.ms, 1000, "memory whole-tree read");
    const leaf = call(() => store.read(["providers", `ep${COUNT - 1}`, "url"]));
    assert.equal(leaf.value, `u${COUNT - 1}`);
    below(leaf.ms, 50, "memory leaf read");
    assert.equal(store.read(["providers", "ep0", "disabled"]), true);
    const writes = call(() => { for (let index = 0; index < 1000; index++) upper.assign(["providers", `ep${index}`, "disabled"], false); });
    below(writes.ms, 1000, "memory 1000 leaf writes");
    return { providers: COUNT, coldReadMs: cold.ms, leafReadMs: leaf.ms, writesMs: writes.ms };
  } finally { store.close(); }
}

async function env() {
  const root = await mkdtemp("ai-tmp/settings-performance-regression-");
  const data = graph();
  let instance;
  try {
    await writeFile(`${root}/settings.json`, JSON.stringify(data));
    const startup = await heartbeat(async () => {
      instance = await Env.open(`${root}/project`, { dir: root, settingsDir: null, init: { providers: false, tools: false, detect: false, models: false } });
    });
    below(startup.gap, 1000, "Env startup heartbeat");
    assert.equal(instance.settings.providers[`ep${COUNT - 1}`].url, `u${COUNT - 1}`);
    let loads = 0;
    instance._sourceGraph.store.on("loaded", () => { loads++; });
    await instance._sourceGraph.store.poll(); // establish the initial loaded count after ready acquisition
    loads = 0;
    data.providers[`ep${COUNT - 1}`].url = "changed";
    // Publish one complete version. In-place writes can be observed midway by
    // the Env's background poll, yielding two legitimate load notifications.
    await writeFile(`${root}/settings.json.next`, JSON.stringify(data));
    await rename(`${root}/settings.json.next`, `${root}/settings.json`);
    const changed = await heartbeat(() => instance._sourceGraph.store.poll());
    below(changed.gap, 1000, "Env changed heartbeat");
    assert.ok(loads >= 1, "changed settings must load");
    assert.equal(instance.settings.providers[`ep${COUNT - 1}`].url, "changed");
    // A background poll may have started before the rename and read the old
    // inode. Drain its queued round before counting unchanged polls.
    await instance._sourceGraph.store.poll();
    const settledLoads = loads;
    const unchanged = await heartbeat(async () => { for (let index = 0; index < 20; index++) await instance._sourceGraph.store.poll(); });
    assert.equal(loads, settledLoads);
    below(unchanged.gap, 250, "Env unchanged polls heartbeat");
    return { providers: COUNT, startupMs: startup.gap, changedMs: changed.gap, unchangedMs: unchanged.gap };
  } finally { await instance?.close(); await rm(root, { recursive: true, force: true }); }
}

await performanceCaseDispatch({ memory, env });
