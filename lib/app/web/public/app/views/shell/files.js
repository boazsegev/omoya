/** Lazy, project-scoped file disclosures. References are separate from attachments. */
import { state } from "../../state.js";
import { fileReference } from "../../logic/file-reference.js";

const ENTRY_BATCH = 100;
const projects = new Map();
let currentProject = null;
let mountedView = null;
let projectSignature = "";
let nextId = 0;
const icons = {
  chevron: "m9 5 7 7-7 7",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z",
  file: "M14 3H5v18h14V8Zm0 0v5h5",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  reference: "m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  reveal: "M15.5 15.5 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3",
  upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
  check: "m5 12 4 4L19 6",
  preview: "M14 3h7v7m0-7L10 14M10 4H4v16h16v-6",
};
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}
function icon(name) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  element.setAttribute("viewBox", "0 0 24 24");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  const path = document.createElementNS(element.namespaceURI, "path");
  path.setAttribute("d", icons[name]);
  element.append(path);
  return element;
}
function button(label, name, action, key) {
  const element = node("button", "files-icon");
  element.type = "button";
  element.title = label;
  element.setAttribute("aria-label", label);
  element.append(icon(name));
  if (key) element.dataset.filesFocus = key;
  element.addEventListener("click", action);
  return element;
}
function modelFor(project) {
  if (!projects.has(project)) projects.set(project, {
    project, id: ++nextId, selected: "", expanded: new Set([""]), folders: new Map(),
    revealSupported: false, busy: null, refreshing: false, draft: null, message: "", error: false,
  });
  return projects.get(project);
}
function folderFor(model, path) {
  if (!model.folders.has(path)) model.folders.set(path, { id: ++nextId, entries: null, loading: null, error: "", visibleCount: ENTRY_BATCH });
  return model.folders.get(path);
}
function update(model, focusKey) {
  if (mountedView?.model === model) mountedView.render(focusKey);
}
function status(model, message, error = false) {
  model.message = message;
  model.error = error;
  update(model);
}
function endpoint(action, project, path) {
  const url = new URL(action ? `files/${action}` : "files", location.href);
  url.search = new URLSearchParams({ project: state.projects.find((item) => item.path === project)?.name ?? "", path });
  return url;
}
async function call(action, model, path, options) {
  const response = await fetch(endpoint(action, model.project, path), options);
  let data;
  try { data = await response.json(); }
  catch { throw new Error("The file service did not respond. Try refreshing the folder."); }
  if (!response.ok) {
    const error = new Error(data.error || "The file request failed. Please try again.");
    error.conflict = data.conflict;
    throw error;
  }
  return data;
}
function post(action, model, path, fields = {}) {
  return call(action, model, path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, ...fields }),
  });
}
async function loadFolder(model, path, force = false) {
  const folder = folderFor(model, path);
  if (folder.loading) {
    await folder.loading;
    if (!force) return;
  }
  if (folder.entries !== null && !force) return;
  folder.error = "";
  // Deferring one microtask lets the pending state exist before a synchronous fetch failure.
  folder.loading = Promise.resolve().then(async () => {
    try {
      const data = await call("", model, path);
      folder.entries = data.entries;
      model.revealSupported = data.revealSupported === true;
    } catch (error) { folder.error = error.message || "Could not load this folder. Try again."; }
    finally { folder.loading = null; update(model); }
  });
  update(model);
  return folder.loading;
}
/** One recursion owner for opening, restoring, and refreshing expanded disclosures. */
async function loadExpanded(model, path, force = false) {
  await loadFolder(model, path, force);
  if (!model.expanded.has(path)) return;
  await Promise.all((folderFor(model, path).entries ?? [])
    .filter((entry) => entry.directory && model.expanded.has(entry.path))
    .map((entry) => loadExpanded(model, entry.path, force)));
}
async function refresh(model) {
  if (model.busy || model.refreshing) return;
  model.refreshing = true;
  status(model, "Refreshing expanded folders…");
  await loadExpanded(model, "", true);
  model.refreshing = false;
  const failed = [...model.folders].some(([path, folder]) => model.expanded.has(path) && folder.error);
  status(model, failed ? "Some folders could not refresh. Use their Retry buttons." : "Files are up to date.", failed);
}
function expandAncestors(model, path) {
  const normalized = path.replaceAll("\\", "/");
  model.expanded.add("");
  for (const parent of model.folders.keys()) {
    if (normalized.startsWith(`${parent.replaceAll("\\", "/")}/`)) model.expanded.add(parent);
  }
  model.expanded.add(path);
}
function reference(model, entry) {
  const projectPath = model.project.replaceAll("\\", "/").replace(/\/$/, "");
  const relative = entry.path.replaceAll("\\", "/") || ".";
  const activeProject = state.agent?.project ?? state.projects.find((project) => project.current)?.path;
  const local = activeProject?.replaceAll("\\", "/").replace(/\/$/, "") === projectPath;
  const projectName = state.projects.find((project) => project.path === model.project)?.name ?? "unknown project";
  return fileReference(relative, projectName, local);
}
/** Insert a reference into the draft without sending it. */
export function insertFileReference(text) {
  const input = document.querySelector('textarea[aria-label="Message"]');
  if (!input || input.disabled || input.readOnly) return false;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  return true;
}
async function reveal(model, path) {
  if (model.busy || model.refreshing) return;
  model.busy = { type: "reveal", path };
  status(model, "Opening the file explorer on the Omoya host…");
  try {
    await post("reveal", model, path);
    status(model, "Opened on the Omoya host, not this device.");
  } catch (error) { status(model, error.message, true); }
  finally {
    model.busy = null;
    update(model, document.activeElement === document.body ? `reveal:${path}` : undefined);
  }
}
async function uploadFiles(model, path, files, focusKey = `add:${path}`) {
  if (!files.length || model.busy || model.refreshing) return;
  model.busy = { type: "upload", path };
  model.selected = path;
  expandAncestors(model, path);
  let uploaded = 0;
  let skipped = 0;
  const errors = [];
  for (const [index, file] of files.entries()) {
    status(model, `Uploading ${index + 1} of ${files.length}: ${file.name}…`);
    const form = new FormData();
    form.set("file", file);
    form.set("path", path);
    try {
      try { await call("upload", model, path, { method: "POST", body: form }); }
      catch (error) {
        if (!error.conflict) throw error;
        if (!confirm(`Replace “${file.name}” in ${path || "the project root"}? The existing file will be overwritten.`)) { skipped++; continue; }
        form.set("replace", "true");
        await call("upload", model, path, { method: "POST", body: form });
      }
      uploaded++;
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  await loadFolder(model, path, true);
  model.busy = null;
  const summary = [`${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded.`];
  if (skipped) summary.push(`${skipped} skipped; existing files unchanged.`);
  if (errors.length) summary.push(`${errors.length} failed. ${errors.join(" ")}`);
  const restoreFocus = mountedView?.model === model && mountedView.root.isConnected &&
    (document.activeElement === document.body || mountedView.root.contains(document.activeElement));
  status(model, summary.join(" "), errors.length > 0);
  if (restoreFocus) update(model, focusKey);
}
async function createFolder(model, draft) {
  if (model.busy || model.refreshing) return;
  const name = draft.name;
  if (!name.trim() || name !== name.trim() || /[\\/\x00-\x1f]/.test(name) || [".", ".."].includes(name) || name.length > 255) {
    draft.error = "Enter a name without slashes or leading or trailing spaces.";
    update(model, "new-folder-name");
    return;
  }
  model.busy = { type: "mkdir", path: draft.parent };
  draft.error = "";
  status(model, `Creating ${name}…`);
  try {
    const result = await post("mkdir", model, draft.parent, { name });
    model.draft = null;
    model.selected = result.path;
    await loadFolder(model, draft.parent, true);
    const parent = folderFor(model, draft.parent);
    const index = parent.entries?.findIndex((entry) => entry.path === result.path) ?? -1;
    parent.visibleCount = Math.max(parent.visibleCount, index + 1);
    status(model, `Created folder “${name}”.`);
  } catch (error) {
    draft.error = error.message;
    status(model, `Could not create “${name}”. ${error.message}`, true);
  } finally {
    model.busy = null;
    update(model, model.draft ? "new-folder-name" : `entry:${model.selected}`);
  }
}

class FilesView {
  constructor(container, model) {
    this.container = container;
    this.model = model;
    this.events = new AbortController();
    this.root = node("section", "files-browser");
    this.root.setAttribute("aria-label", "Project files");
    const toolbar = node("div", "files-toolbar");
    this.select = node("select", "files-project");
    this.select.setAttribute("aria-label", "File project");
    for (const project of state.projects) {
      const option = node("option", null, project.name);
      option.value = project.path;
      this.select.append(option);
    }
    this.select.value = model?.project ?? "";
    this.select.disabled = !model;
    this.select.addEventListener("change", () => {
      this.closeMenu();
      currentProject = this.select.value;
      this.model = modelFor(currentProject);
      this.render();
      void loadExpanded(this.model, "");
    });
    this.refreshButton = button("Refresh expanded folders", "refresh", () => void refresh(this.model), "refresh");
    this.addButton = this.addControl("", "toolbar-add");
    toolbar.append(this.select, this.refreshButton, this.addButton);
    this.destination = node("div", "files-destination");
    const destinationLabel = node("span", "files-destination-label", "Destination");
    this.destinationName = node("span", "files-destination-name");
    this.clearButton = button("Clear selected destination; use project root", "close", () => {
      this.model.selected = "";
      this.closeMenu();
      this.render("toolbar-add");
    }, "clear-destination");
    this.destination.append(destinationLabel, this.destinationName, this.clearButton);
    this.body = node("div", "files-body");
    this.message = node("p", "files-status");
    this.message.setAttribute("role", "status");
    this.message.setAttribute("aria-live", "polite");
    this.message.setAttribute("aria-atomic", "true");
    const hint = node("p", "files-hint", "Drag a file or folder into your message to reference it.");
    this.picker = node("input");
    this.picker.type = "file";
    this.picker.multiple = true;
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => {
      const target = this.uploadTarget;
      const files = [...this.picker.files];
      this.picker.value = "";
      if (target) void uploadFiles(target.model, target.path, files, target.key);
    });
    this.menu = node("div", "files-menu");
    this.menu.id = `files-menu-${++nextId}`;
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    this.root.append(toolbar, this.destination, this.body, this.message, hint, this.picker, this.menu);
    container.replaceChildren(this.root);
    const options = { signal: this.events.signal };
    document.addEventListener("pointerdown", (event) => {
      if (this.menuState && !this.menu.contains(event.target) && !this.focusTarget(this.menuState.key)?.contains(event.target)) this.closeMenu();
    }, options);
    document.addEventListener("focusin", (event) => {
      if (this.menuState && !this.menu.contains(event.target) && !this.focusTarget(this.menuState.key)?.contains(event.target)) this.closeMenu();
    }, options);
    document.addEventListener("scroll", (event) => { if (!this.menu.contains(event.target)) this.closeMenu(); }, { ...options, capture: true });
    window.addEventListener("resize", () => this.closeMenu(), options);
    this.menu.addEventListener("keydown", (event) => {
      const items = [...this.menu.querySelectorAll("button")];
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); items[next].focus(); }
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        this.closeMenu(true);
      }
    });
    this.render();
  }
  dispose() { this.events.abort(); this.closeMenu(); }
  focusTarget(key) { return [...this.root.querySelectorAll("[data-files-focus]")].find((element) => element.dataset.filesFocus === key); }
  addControl(path, key) {
    const element = button("Add to folder", "plus", () => this.openMenu(path, key), key);
    element.setAttribute("aria-haspopup", "menu");
    element.setAttribute("aria-expanded", "false");
    element.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.openMenu(path, key, event.key === "ArrowUp");
      }
      if (event.key === "Escape" && this.menuState) { event.preventDefault(); event.stopPropagation(); this.closeMenu(true); }
    });
    return element;
  }
  closeMenu(restoreFocus = false) {
    const key = this.menuState?.key;
    this.menuState = null;
    this.menu.hidden = true;
    for (const element of this.root.querySelectorAll('[aria-haspopup="menu"]')) element.setAttribute("aria-expanded", "false");
    if (restoreFocus && key) this.focusTarget(key)?.focus({ preventScroll: true });
  }
  openMenu(path, key, last = false) {
    const model = this.model;
    if (!model || model.busy || model.refreshing) return;
    if (this.menuState?.key === key) { this.closeMenu(true); return; }
    this.closeMenu();
    path = key === "toolbar-add" ? model.selected : path;
    model.selected = path;
    this.render();
    this.menuState = { path, key };
    this.menu.setAttribute("aria-label", `Add to ${path || "project root"}`);
    const upload = button("Upload files", "upload", () => {
      this.closeMenu(true);
      this.uploadTarget = { model, path, key };
      this.picker.click();
    });
    const mkdir = button("New folder", "folder", () => {
      this.closeMenu();
      model.draft = { parent: path, name: "", error: "" };
      expandAncestors(model, path);
      this.render("new-folder-name");
      void loadExpanded(model, path);
    });
    for (const [element, text] of [[upload, "Upload files"], [mkdir, "New folder"]]) {
      element.className = "files-menu-item";
      element.setAttribute("role", "menuitem");
      element.tabIndex = -1;
      element.append(node("span", null, text));
    }
    this.menu.replaceChildren(upload, mkdir);
    const anchor = this.focusTarget(key);
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", this.menu.id);
    const rect = anchor.getBoundingClientRect();
    this.menu.hidden = false;
    const menuRect = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8))}px`;
    (last ? mkdir : upload).focus({ preventScroll: true });
  }
  render(focusKey) {
    if (!this.root.isConnected) return;
    const model = this.model;
    const active = this.root.contains(document.activeElement) ? document.activeElement : null;
    const key = focusKey ?? active?.dataset.filesFocus;
    const selection = active?.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = this.container.scrollTop;
    const disabled = !model || !!model.busy || model.refreshing;
    this.refreshButton.disabled = disabled;
    this.refreshButton.classList.toggle("is-pending", !!model?.refreshing);
    this.refreshButton.setAttribute("aria-label", model?.refreshing ? "Refreshing expanded folders" : "Refresh expanded folders");
    this.addButton.disabled = disabled;
    this.addButton.setAttribute("aria-label", `Add to ${model?.selected || "project root"}`);
    this.addButton.title = this.addButton.getAttribute("aria-label");
    this.destinationName.textContent = model?.selected || "Project root";
    this.destinationName.title = model?.selected || "Project root";
    this.destination.hidden = !model;
    this.clearButton.hidden = !model?.selected;
    this.message.textContent = model?.message || (!model ? "No projects available." : "");
    this.message.hidden = !this.message.textContent;
    this.message.classList.toggle("is-error", !!model?.error);
    if (model) {
      const list = node("ul", "files-list");
      const project = state.projects.find((project) => project.path === model.project);
      list.append(this.entry({ name: project?.name || "Project root", path: "", directory: true }, true));
      this.body.replaceChildren(list);
    } else this.body.replaceChildren();
    this.container.scrollTop = scroll;
    const target = key && this.focusTarget(key);
    if (target && target !== document.activeElement && !target.disabled) {
      target.focus({ preventScroll: true });
      if (selection && target.tagName === "INPUT") target.setSelectionRange(...selection);
    }
    if (this.menuState) {
      const anchor = this.focusTarget(this.menuState.key);
      if (!anchor || disabled) this.closeMenu();
      else { anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-controls", this.menu.id); }
    }
  }
  entry(entry, root = false) {
    const model = this.model;
    const { path, directory } = entry;
    const label = root ? "project root" : path;
    const item = node("li", "files-item");
    const row = node("div", "files-row");
    row.classList.toggle("is-selected", directory && model.selected === path);
    const main = node(directory ? "button" : "span", "files-entry");
    main.title = path || "Project root";
    main.dataset.filesFocus = `entry:${path}`;
    main.draggable = true;
    main.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "copy";
      const text = reference(model, entry);
      event.dataTransfer.setData("application/x-omoya-reference", text);
      event.dataTransfer.setData("text/plain", text);
    });
    if (directory) {
      const folder = folderFor(model, path);
      const expanded = model.expanded.has(path);
      const childrenId = `files-folder-${folder.id}`;
      main.type = "button";
      main.setAttribute("aria-expanded", String(expanded));
      main.setAttribute("aria-controls", childrenId);
      const chevron = node("span", "files-chevron");
      chevron.append(icon("chevron"));
      main.append(chevron);
      main.addEventListener("click", () => {
        this.closeMenu();
        model.selected = path;
        if (model.expanded.has(path)) model.expanded.delete(path);
        else { model.expanded.add(path); void loadExpanded(model, path); }
        this.render();
      });
      this.dropTarget(row, path);
    } else {
      main.tabIndex = -1; // Programmatic focus after Show more, without adding a Tab stop.
      main.append(node("span", "files-chevron"));
    }
    main.append(icon(directory ? "folder" : "file"), node("span", "files-name", root ? "Project root" : entry.name));
    row.append(main);
    const rowActions = node("span", "files-actions");
    if (directory) {
      const add = this.addControl(path, `add:${path}`);
      add.title = `Add to ${label}`;
      add.setAttribute("aria-label", add.title);
      add.disabled = !!model.busy || model.refreshing;
      rowActions.append(add);
    }
    const addReference = button(`Add reference to ${directory ? "folder " : ""}${label}`, "reference", () => {
      const inserted = insertFileReference(reference(model, entry));
      status(model, inserted ? `Added reference to ${label}.` : "Open a conversation to add a reference.", !inserted);
    }, `reference:${path}`);
    let revealButton = null;
    if (model.revealSupported) {
      const open = button(`Reveal ${label} on the Omoya host`, "reveal", () => void reveal(model, path), `reveal:${path}`);
      open.disabled = !!model.busy || model.refreshing;
      open.classList.toggle("is-pending", model.busy?.type === "reveal" && model.busy.path === path);
      revealButton = open;
    }
    if (!directory && entry.markdown) {
      const preview = node("a", "files-icon");
      const url = new URL("markdown-preview.html", location.href);
      url.search = new URLSearchParams({ project: state.projects.find((item) => item.path === model.project)?.name ?? "", path });
      preview.href = url.href;
      preview.target = "_blank";
      preview.rel = "noopener";
      preview.title = `Preview ${entry.name} in a new tab`;
      preview.setAttribute("aria-label", preview.title);
      preview.dataset.filesFocus = `preview:${path}`;
      preview.append(icon("preview"));
      rowActions.append(preview);
    }
    if (revealButton) rowActions.append(revealButton);
    rowActions.append(addReference);
    row.append(rowActions);
    item.append(row);
    if (directory) {
      const folder = folderFor(model, path);
      const list = node("ul", "files-list files-children");
      list.id = `files-folder-${folder.id}`;
      list.hidden = !model.expanded.has(path);
      list.setAttribute("aria-busy", String(!!folder.loading));
      if (!list.hidden) {
        if (model.draft?.parent === path) list.append(this.newFolderForm(model.draft));
        const entries = folder.entries ?? [];
        for (const child of entries.slice(0, folder.visibleCount)) list.append(this.entry(child));
        if (entries.length > folder.visibleCount) {
          const remaining = entries.length - folder.visibleCount;
          const moreItem = node("li", "files-more-item");
          const more = node("button", "files-more", `Show next ${Math.min(ENTRY_BATCH, remaining)} · ${remaining.toLocaleString()} remaining`);
          more.type = "button";
          more.dataset.filesFocus = `more:${path}`;
          more.setAttribute("aria-label", `Show next ${Math.min(ENTRY_BATCH, remaining)} entries in ${label}; ${remaining.toLocaleString()} remaining`);
          more.addEventListener("click", () => {
            const firstNew = entries[folder.visibleCount];
            folder.visibleCount += ENTRY_BATCH;
            this.render(`entry:${firstNew.path}`);
          });
          moreItem.append(more);
          list.append(moreItem);
        }
        if (folder.loading) list.append(node("li", "files-notice", "Loading…"));
        else if (folder.error) {
          const error = node("li", "files-notice is-error", folder.error);
          const retry = node("button", "files-retry", "Retry");
          retry.type = "button";
          retry.dataset.filesFocus = `retry:${path}`;
          retry.setAttribute("aria-label", `Retry loading ${label}`);
          retry.addEventListener("click", () => void loadExpanded(model, path, true));
          error.append(retry);
          list.append(error);
        } else if (folder.entries?.length === 0 && model.draft?.parent !== path) list.append(node("li", "files-notice", "This folder is empty."));
      }
      item.append(list);
    }
    return item;
  }
  newFolderForm(draft) {
    const model = this.model;
    const item = node("li", "files-form-item");
    const form = node("form", "files-new-folder");
    form.noValidate = true;
    const label = node("label", "files-sr-only", "New folder name");
    const input = node("input", "files-folder-name");
    input.id = `files-new-folder-${model.id}`;
    label.htmlFor = input.id;
    input.value = draft.name;
    input.placeholder = "Folder name";
    input.maxLength = 255;
    input.autocomplete = "off";
    input.required = true;
    input.dataset.filesFocus = "new-folder-name";
    input.disabled = model.busy?.type === "mkdir";
    const error = node("p", "files-form-error", draft.error);
    error.id = `${input.id}-error`;
    error.hidden = !draft.error;
    input.setAttribute("aria-invalid", String(!!draft.error));
    input.setAttribute("aria-describedby", error.id);
    input.addEventListener("input", () => {
      draft.name = input.value;
      draft.error = "";
      error.hidden = true;
      input.setAttribute("aria-invalid", "false");
    });
    const cancel = () => {
      if (model.busy?.type === "mkdir") return;
      model.draft = null;
      this.render(`add:${draft.parent}`);
    };
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    const save = button("Create folder", "check", () => {}, "new-folder-save");
    save.type = "submit";
    save.disabled = !!model.busy || model.refreshing;
    const close = button("Cancel new folder", "close", cancel, "new-folder-cancel");
    close.disabled = model.busy?.type === "mkdir";
    form.append(label, input, save, close, error);
    form.addEventListener("submit", (event) => { event.preventDefault(); void createFolder(model, draft); });
    item.append(form);
    return item;
  }
  dropTarget(row, path) {
    const externalFiles = (event) => event.dataTransfer?.types.includes("Files") && !event.dataTransfer.types.includes("application/x-omoya-reference");
    row.addEventListener("dragover", (event) => {
      if (!externalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = this.model.busy || this.model.refreshing ? "none" : "copy";
      if (!this.model.busy && !this.model.refreshing) row.classList.add("is-drop-target");
    });
    row.addEventListener("dragleave", (event) => { if (!row.contains(event.relatedTarget)) row.classList.remove("is-drop-target"); });
    row.addEventListener("drop", (event) => {
      if (!externalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove("is-drop-target");
      if (this.model.busy || this.model.refreshing) return;
      if ([...(event.dataTransfer.items ?? [])].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        status(this.model, "Folders cannot be uploaded. Choose individual files instead.", true);
        return;
      }
      void uploadFiles(this.model, path, [...event.dataTransfer.files]);
    });
  }
}

/** Mount once per sidebar mode/project-list change; retain disclosures per project. */
export function mountFiles(container) {
  const stylesheet = new URL("./files.css", import.meta.url).href;
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => link.href === stylesheet)) {
    const link = node("link");
    link.rel = "stylesheet";
    link.href = stylesheet;
    document.head.append(link);
  }
  const signature = JSON.stringify(state.projects.map(({ name, path, current }) => ({ name, path, current })));
  if (mountedView?.container === container && mountedView.root.parentElement === container && signature === projectSignature) return;
  mountedView?.dispose();
  projectSignature = signature;
  if (!state.projects.some((project) => project.path === currentProject)) currentProject = state.projects.find((project) => project.current)?.path ?? state.projects[0]?.path ?? null;
  const model = currentProject ? modelFor(currentProject) : null;
  mountedView = new FilesView(container, model);
  if (model) void loadExpanded(model, "");
}
