/** Omoya browser SPA: sole compositor of domain handlers and view APIs. */
import { copyText, installCopyListener } from "./app/markdown-copy.js";
import { toast } from "./app/dom.js";
import { initTheme, applyTheme, selectedTheme } from "./app/theme-service.js";
import { state } from "./app/state.js";
import * as composer from "./app/views/composer/composer.js";
import * as panels from "./app/views/panels/panels.js";
import * as shell from "./app/views/shell/shell.js";
import * as theme from "./app/views/panels/theme.js";
import * as tools from "./app/orchestrators/turn-tools.js";
import * as turnState from "./app/orchestrators/turn-state.js";
const { showThrottle, setHistory, onDelta, onTurnEnd } = turnState;
import * as transcript from "./app/views/transcript/transcript.js";
import * as viewer from "./app/views/viewer/viewer.js";
import * as wire from "./app/wire.js";
import { compose } from "./app/dispatch.js";
import { register, invalidate } from "./app/render.js";
import { session } from "./app/orchestrators/session.js";
import { turn } from "./app/orchestrators/turn.js";
import { endpoints } from "./app/orchestrators/endpoints.js";
import { context } from "./app/orchestrators/context.js";
import { questions } from "./app/orchestrators/questions.js";
import { prefs } from "./app/orchestrators/prefs.js";
const send = (packet) => { if (!wire.send(packet)) toast("Not connected — reconnecting…", true); };
const ui = { packets: {}, intents: {
  "server": (_ctx, packet) => send(packet),
  "composer.build": () => composer.buildComposer(),
  "composer.queue": () => shell.renderComposerQueue(),
  "composer.tools": () => composer.updateComposerTools(),
  "composer.acOpen": () => composer.acOpen(),
  "composer.insert": (_ctx, payload) => Array.isArray(payload) ? composer.insertComposer(...payload) : composer.insertComposer(payload),
  "viewer.open": (_ctx, payload) => Array.isArray(payload) ? viewer.openContextViewer(...payload) : viewer.openContextViewer(payload),
  "viewer.close": () => viewer.closeContextViewer(),
  "context.delete": (_ctx, indexes) => transcript.deleteContextMessages(indexes),
  "dialog.open": (_ctx, options) => panels.openDialog(options),
  "menu.open": (_ctx, [anchor, items]) => panels.openMenu(anchor, items),
  "project.actions": (_ctx, project) => panels.projectActions(project),
  "palette.open": () => panels.openPalette(),
  "settings.open": () => panels.openSettings(),
  "login.open": () => panels.openLogin(),
  "themes.open": () => theme.openThemes(),
  "tools.open": () => panels.openToolDialog(),
  "help.open": () => panels.openHelp(),
  "agent.add": () => panels.openAddAgent(),
  "agent.rename": (_ctx, agent) => panels.renameAgentPrompt(agent),
  "session.rename": (_ctx, id) => panels.renameSessionPrompt(id),
  "model.open": () => panels.openModelPicker(),
  "endpoint.open": () => panels.openEndpointPicker(),
  "theme.selected": () => selectedTheme(),
  "theme.apply": () => applyTheme(),
  "theme.choose": (_ctx, name) => theme.chooseTheme(name),
  "theme.body": () => theme.renderThemesBody(),
  "panels.refresh": () => panels.refreshOpenPanels(),
  "transcript.jump": () => transcript.syncJumpButtons(),
  "transcript.render": (_ctx, full) => transcript.scheduleRender(full),
} };
const ctx = {
  state, invalidate, send, toast, showThrottle, setHistory, onDelta, onTurnEnd,
  settleCurrent: turnState.settleCurrent, pushBlock: turnState.pushBlock,
  startToolCall: tools.startToolCall, appendToolCall: tools.appendToolCall,
  finishToolCall: tools.finishToolCall, startToolAnswer: tools.startToolAnswer,
  appendToolData: tools.appendToolData, finishTool: tools.finishTool,
  copyText,
};
const dispatch = compose([session, turn, endpoints, context, questions, prefs, ui], ctx);
const emit = (name, payload) => dispatch.intent(name, payload);
for (const view of [shell, composer, transcript, panels, theme, viewer]) view.mount(document.querySelector("#app"), { emit });
register("shell", () => shell.render());
register("header", () => shell.updateHeader());
register("sidebar", () => shell.updateSidebar());
register("usage", () => shell.updateUsage());
register("composer", () => { shell.updateComposerActivity(); composer.updateComposerTools(); shell.renderComposerQueue(); if (state.composerFill !== undefined) { composer.fillComposer(state.composerFill); state.composerFill = undefined; } });
register("transcript", () => transcript.scheduleRender());
register("viewer", () => { if (!state.contextView) viewer.closeContextViewer(); else viewer.renderContextViewer(); });
register("questions", () => { if (state.openQuestion) panels.renderQuestion(); else panels.closeQuestion(); });
register("theme", () => applyTheme());
register("panels", () => { if (state.openView) { const { view, packet } = state.openView; state.openView = null; panels.openView(view, packet); } panels.refreshOpenPanels(); });
wire.onPacket(dispatch.packet);
wire.onStatus((status) => {
  state.connection = status;
  if (status === "open") wire.send({ type: "session.list" });
  shell.updateHeader(); shell.updateSidebar();
});
installCopyListener();
shell.installKeys();
initTheme(theme.renderThemesBody);
wire.connect();
shell.render();
