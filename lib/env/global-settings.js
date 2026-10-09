/** Process-owned global settings facade; never constructs or registers a project Env. */
import { defaultSettingsDir, defaultSettingsDirAsync } from "./paths.js";
import { configuredExtensions } from "./extensions.js";
import { sourceGraphCreate } from "./source-graph.js";
import { storeSettingsCreate } from "./store-settings.js";
import { settingsView } from "./settings-view.js";

let owner;

function settingsOwner(dir) {
  if (owner) return owner;
  const settingsDirReady = defaultSettingsDirAsync();
  const context = { cwd: dir, _settingsDir: defaultSettingsDir() };
  const extensionRoots = settingsDirReady.then((settingsDir) => configuredExtensions({ dir, settingsDir }));
  context._sourceGraph = sourceGraphCreate({ dir, cwd: dir, settingsDir: context._settingsDir, extensionRoots, globalOnly: true });
  context._settingsAccess = storeSettingsCreate(context, context._sourceGraph.store, { ...context._sourceGraph, globalOnly: true });
  const ready = (async () => {
    context._settingsDir = await settingsDirReady;
    await context._sourceGraph.ready();
    return settingsView(context);
  })();
  void ready.catch(() => {});
  owner = { context, ready, closing: null };
  return owner;
}

export function globalSettingsRead(dir) { return settingsView(settingsOwner(dir).context); }
export function globalSettingsReady(dir) { return settingsOwner(dir).ready; }
export function globalSettingsFlush(dir) { return settingsOwner(dir).context._sourceGraph.flush(); }
export function globalSettingsClose() {
  if (!owner) return Promise.resolve();
  const current = owner;
  return current.closing ??= (async () => {
    const errors = [];
    try {
      await Promise.allSettled([current.ready]);
      try { await current.context._sourceGraph.flush(); } catch (error) { errors.push(error); }
      try { await current.context._sourceGraph.close(); } catch (error) { errors.push(error); }
    } finally { if (owner === current) owner = undefined; }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Env global settings failed to close");
  })();
}
