/** Reusable, pure overlay forms. GTUI owns editing; callers own operations and their lifetimes. */
import { view } from "../gtui/gtui.js";

export const FORM_INPUT_PREFIX = "form-input:";
export const FORM_MENU_ID = "form-menu";
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype", "_form"]);
const SUBMIT = "form.submit";
const CANCEL = "form.cancel";
const DETAILS = "form.details";
const BACK = "form.back";
const CHOICE = "form.choice";
const DETAILS_ID = "form-details";

/** Normalize one editor value without retaining caller data. */
function fieldValue(field, value) {
  const text = String(value ?? "");
  return field.multiline ? text : text.replace(/[\r\n]+/gu, " ");
}

/** Validate/copy descriptors at the public boundary; values have a single owner in overlay.values. */
function fieldsCopy(fields) {
  if (!Array.isArray(fields)) throw new TypeError("form fields must be an array");
  const names = new Set();
  return fields.map((field) => {
    if (!field || typeof field.name !== "string" || field.name === "" || FORBIDDEN_NAMES.has(field.name) || names.has(field.name)) {
      throw new TypeError("form fields need unique, safe, non-empty names");
    }
    if (typeof field.label !== "string") throw new TypeError("form fields need labels");
    if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option) => !option || typeof option.label !== "string" || option.value === undefined
      || (option.group !== undefined && typeof option.group !== "string")))) {
      throw new TypeError("form options need label and value, with an optional string group");
    }
    names.add(field.name);
    return {
      name: field.name, label: field.label, placeholder: String(field.placeholder ?? ""),
      secret: field.secret === true, multiline: field.multiline === true, required: field.required === true,
      hint: String(field.hint ?? ""), custom: field.custom !== false,
      options: field.options?.map((option) => ({ label: option.label, value: String(option.value), ...(option.group !== undefined ? { group: option.group } : {}) })) ?? [],
    };
  });
}

/**
 * Create an editable overlay without terminal or operation side effects.
 * @param {object} options Form description; fields may be empty, but names must be unique and safe.
 * @param {string} options.title Heading.
 * @param {Array<{name:string,label:string,value?:*,placeholder?:string,secret?:boolean,multiline?:boolean,required?:boolean,hint?:string,custom?:boolean,options?:Array<{label:string,value:*}>}>} options.fields Editor descriptors. Values/options are text; options use an arrow-key chooser with a custom-text path. Set custom:false for closed choices; choice validation remains parent-owned.
 * @param {object} options.action Opaque operation descriptor, shallow-copied and returned on submission.
 * @param {string} [options.submitLabel="Save"] Explicit submission label.
 * @param {object} [options.back] Borrowed previous overlay; cancellation does not mutate or navigate it.
 * @param {string} [options.details=""] Explanatory text.
 * @returns {object} New {type:'form',fields,values,focus,errors,busy,...} state. Focus is a field index, or fields.length for the final menu; values are the single source of editor text. Caller owns state, including secrets; do not log it.
 * @throws {TypeError} Invalid fields, duplicate/unsafe names, missing labels, malformed options, or a non-object action. String conversion errors propagate; retrying creation is safe.
 * Does not mutate inputs; nested action data and back are retained. This is not an operation runner.
 */
export function createForm({ title, fields, submitLabel = "Save", action, back, details = "" }) {
  if (!action || typeof action !== "object" || Array.isArray(action)) throw new TypeError("form action must be an object");
  const descriptors = fieldsCopy(fields);
  const values = Object.fromEntries(descriptors.map((field, index) => [field.name, fieldValue(field, fields[index].value)]));
  return {
    type: "form", title: String(title ?? ""), fields: descriptors, values,
    submitLabel: String(submitLabel), action: { ...action }, back, details: String(details),
    focus: 0, errors: {}, busy: false, editors: {}, menuIndex: 0, choices: {}, reading: false,
  };
}

/** Remove actual secret values from user-visible metadata, including parent validation errors. */
function presentationText(overlay, text) {
  let result = String(text ?? "");
  for (const field of overlay.fields) {
    const secret = overlay.values[field.name];
    if (field.secret && secret !== "") result = result.replaceAll(secret, "[masked]");
  }
  return result;
}

/** Collapse prose to one row; full, unmodified explanations live in the reader. */
function compactText(overlay, content, role = "muted", props = {}) {
  return view.text({ role, overflow: "clip-end", ...props }, presentationText(overlay, content).replace(/\s+/gu, " "));
}

/** Derive the default choice from controlled text; never change an unknown/custom default. */
function choiceState(overlay, field) {
  if (Object.hasOwn(overlay.choices ?? {}, field.name)) return overlay.choices[field.name];
  const index = field.options.findIndex((option) => option.value === overlay.values[field.name]);
  return { index: Math.max(0, index), custom: field.custom && index < 0 && overlay.values[field.name] !== "", query: "" };
}

/** Return original option indexes matching the same label/value metadata searched by GTUI. */
function matchingChoices(field, query) {
  const needle = query.toLowerCase();
  return field.options.map((option, index) => ({ option, index }))
    .filter(({ option }) => `${option.label} ${option.value}`.toLowerCase().includes(needle));
}

/** Chooser rows: one action per option, with a header row whenever the
 * option group changes, plus the custom escape hatch last. Headers are
 * unselectable labels; only CHOICE-valued rows change the field. */
function choiceItems(overlay, field) {
  const items = [];
  field.options.forEach((option, optionIndex) => {
    if (option.group !== undefined && option.group !== "" && (optionIndex === 0 || field.options[optionIndex - 1].group !== option.group)) {
      items.push({ kind: "header", label: presentationText(overlay, option.group) });
    }
    items.push({
      kind: "action", label: presentationText(overlay, option.label).replace(/\s+/gu, " "), note: "",
      value: { type: CHOICE, index: optionIndex },
    });
  });
  if (field.custom) items.push({ kind: "action", label: "Custom value…", alwaysVisible: true, value: { type: CHOICE, index: field.options.length } });
  return items;
}

/** The unfiltered chooser row index of one option, accounting for group headers. */
function choiceRow(overlay, field, optionIndex) {
  let headers = 0;
  for (let index = 0; index <= optionIndex; index++) {
    if (field.options[index].group !== undefined && field.options[index].group !== "" && (index === 0 || field.options[index - 1].group !== field.options[index].group)) headers++;
  }
  return optionIndex + headers;
}

/** Only the focused field occupies editing space; metadata has a single clipped row. */
function fieldView(overlay, field, index) {
  const editor = Object.hasOwn(overlay.editors, field.name) ? overlay.editors[field.name] : undefined;
  const error = Object.hasOwn(overlay.errors, field.name) ? overlay.errors[field.name] : "";
  const choice = choiceState(overlay, field);
  const choosing = field.options.length > 0 && !choice.custom;
  const label = `${index + 1}/${overlay.fields.length} ${field.label}${field.required ? " *" : ""}`;
  const explanation = error || overlay.errors._form || field.hint || overlay.details;
  const query = choice.query ?? "";
  const matching = matchingChoices(field, query);
  const selectedIndex = matching.findIndex((entry) => entry.index === choice.index);
  const items = choosing ? choiceItems(overlay, field) : [];
  const control = choosing ? view.menu({
    id: FORM_INPUT_PREFIX + field.name, focus: true, query,
    // clip-end lets a label run to the full chooser width before the tail is
    // clipped; a mid-label break would cut names far earlier than necessary.
    labelOverflow: "clip-end",
    title: presentationText(overlay, label),
    items,
    initialIndex: choice.index === field.options.length
      ? (query === "" ? items.length - 1 : matching.length)
      : (query === "" ? choiceRow(overlay, field, choice.index) : Math.max(0, selectedIndex)),
    stateKey: JSON.stringify([field.name, choice.index, query]), priority: 200,
  }) : view.input({
    id: FORM_INPUT_PREFIX + field.name, value: overlay.values[field.name],
    caret: editor?.caret, selection: editor?.selection ?? null,
    placeholder: presentationText(overlay, field.placeholder), mask: field.secret,
    focus: true, active: false, maxRows: field.multiline ? 5 : 1, priority: 200,
    bubbleKeys: ["tab", "shift+tab", "escape", "ctrl+c", "ctrl+s", ...(field.options.length ? ["up", "down"] : [])],
  });
  const metadata = [
    ...(!choosing ? [compactText(overlay, label + (field.options.length ? " · ↑/↓ choices" : ""), "menu.header", { priority: 50 })] : []),
    ...(explanation ? [compactText(overlay, explanation, error || overlay.errors._form ? "error" : "muted")] : []),
  ];
  // Fill allocates the remainder to the CONTROL, not wrapping prose. At
  // 30×10 the overlay has nine rows: title + metadata + control + actions.
  return view.column({ viewportFill: true, priority: 200, rows: [...metadata.map(() => "auto"), "fill"] }, [...metadata, control]);
}

/** Explicit full-text reader; entering/leaving never replaces or loses editor state. */
function detailsView(overlay) {
  const text = (content, role = "muted") => view.text({ role }, presentationText(overlay, content));
  return view.column({ viewportFill: true, rows: ["auto", "fill", "auto"] }, [
    compactText(overlay, `${overlay.title} · Details`, "menu.header"),
    view.scroll({ id: DETAILS_ID, focus: true, keyboard: true, offset: overlay.detailsOffset ?? 0 }, [view.column({}, [
      text(overlay.title, "menu.header"),
      ...(overlay.details ? [text(overlay.details)] : []),
      ...(overlay.errors._form ? [text(overlay.errors._form, "error")] : []),
      ...overlay.fields.flatMap((field) => [
        text(field.label, "menu.header"),
        ...(field.options.length ? [text(field.secret ? "Selected: [masked]" : `Selected: ${field.options.find((option) => option.value === overlay.values[field.name])?.label ?? "Custom value"}\n${overlay.values[field.name]}`)] : []),
        ...(field.hint ? [text(field.hint)] : []),
        ...(overlay.errors[field.name] ? [text(overlay.errors[field.name], "error")] : []),
      ]),
    ])]),
    view.toolbar({ id: "form-reader-actions" }, [view.button({ action: BACK }, "Back · Esc")]),
  ]);
}

/**
 * Render one focused editor/chooser and a one-row explicit Save/Cancel toolbar.
 * @param {object} overlay State from createForm/updateForm/formErrors; borrowed, never mutated. An optional preparing:true on busy state presents loading rather than submitted work.
 * @returns {object} Frozen GTUI overlay tree. Every editor/chooser has FORM_INPUT_PREFIX + name; the final toolbar has FORM_MENU_ID. Masked input nodes keep actual text only in their non-enumerable value for GTUI editing; visible/snapshot/debug text is redacted. Tab visits each field/actions; ? on the toolbar opens full explanations.
 * @throws {TypeError} Malformed state can fail while reading fields or values.
 * Pure query, repeatable, with no terminal effects. Both terminal hosts use the same nodes.
 */
export function formView(overlay) {
  if (overlay.reading && !overlay.busy) return view.overlay({ fill: true }, [detailsView(overlay)]);
  const editing = !overlay.busy && overlay.focus < overlay.fields.length;
  const progress = overlay.preparing ? "Loading options… · no changes submitted" : "Working… · Esc hides progress; submitted work may still finish";
  const hasDetails = Boolean(overlay.title || overlay.details || Object.keys(overlay.errors).length || overlay.fields.some((field) => field.hint || field.options.length));
  const actions = view.toolbar({ id: FORM_MENU_ID, focus: !editing, gap: 1, priority: 300 }, [
    ...(!overlay.busy ? [view.button({ action: SUBMIT, priority: 100 }, presentationText(overlay, overlay.submitLabel))] : []),
    view.button({ action: CANCEL, priority: 100 }, overlay.busy && !overlay.preparing ? "Hide progress" : "Cancel"),
    ...(!overlay.busy && hasDetails ? [view.button({ action: DETAILS }, "?")] : []),
  ]);
  const body = overlay.busy ? view.text({ role: "muted" }, presentationText(overlay, progress))
    : editing ? fieldView(overlay, overlay.fields[overlay.focus], overlay.focus)
      : view.scroll({ id: "form-before", keyboard: true }, [view.column({}, [
        ...(overlay.errors._form || overlay.details ? [compactText(overlay, overlay.errors._form || overlay.details, overlay.errors._form ? "error" : "muted")] : []),
        ...overlay.fields.map((field) => compactText(overlay, `${field.label}: ${field.secret ? "[masked]" : overlay.values[field.name]}`)),
      ])]);
  return view.overlay({ fill: true }, [view.column({ viewportFill: true, rows: ["auto", "fill", "auto"] }, [
    compactText(overlay, overlay.title, "menu.header", { priority: 10 }),
    body,
    actions,
  ])]);
}

/** Preserve a clamped controlled caret/selection without retaining external selection objects. */
function editorCopy(message, value, previous) {
  const clamp = (offset) => Math.max(0, Math.min(value.length, Number.isInteger(offset) ? offset : value.length));
  const selection = message.selection === undefined ? previous?.selection : message.selection;
  return {
    caret: clamp(message.caret ?? previous?.caret),
    selection: selection ? { anchor: clamp(selection.anchor), caret: clamp(selection.caret) } : null,
  };
}

/** Store a known editor event, preserving all unrelated fields and validation errors. */
function inputUpdate(overlay, index, message) {
  const field = overlay.fields[index];
  const value = message.value === undefined ? overlay.values[field.name] : fieldValue(field, message.value);
  const errors = { ...overlay.errors };
  if (value !== overlay.values[field.name]) {
    delete errors[field.name];
    delete errors._form;
  }
  return {
    ...overlay, focus: index, values: { ...overlay.values, [field.name]: value }, errors,
    ...(field.options.length ? { choices: { ...overlay.choices, [field.name]: { ...choiceState(overlay, field), custom: true } } } : {}),
    editors: { ...overlay.editors, [field.name]: editorCopy(message, value, Object.hasOwn(overlay.editors, field.name) ? overlay.editors[field.name] : undefined) },
  };
}

/** Store a chooser highlight or confirmation, keeping its cursor separate from custom text. */
function choiceUpdate(overlay, index, selected, confirm) {
  const field = overlay.fields[index];
  if (!Number.isInteger(selected) || selected < 0 || selected >= field.options.length + Number(field.custom)) return { overlay, handled: true };
  if (selected === field.options.length) {
    return { overlay: { ...overlay, focus: index, choices: { ...overlay.choices, [field.name]: { ...choiceState(overlay, field), index: selected, custom: confirm } } }, handled: true };
  }
  const next = inputUpdate(overlay, index, { value: field.options[selected].value });
  return {
    overlay: { ...next, focus: confirm ? index + 1 : index, choices: { ...next.choices, [field.name]: { ...choiceState(overlay, field), index: selected, custom: false } } },
    handled: true,
  };
}

/** Perform only generic required checks; operation/choice validation belongs to the parent. */
function submitForm(overlay) {
  if (overlay.busy) return { overlay, handled: true };
  const errors = {};
  for (const field of overlay.fields) {
    if (field.required && overlay.values[field.name].trim() === "") errors[field.name] = `${field.label} is required.`;
  }
  if (Object.keys(errors).length > 0) return { overlay: formErrors(overlay, errors), handled: true };
  return { overlay: { ...overlay, busy: true, errors: {} }, submit: { action: overlay.action, values: { ...overlay.values } }, handled: true };
}

/**
 * Reduce GTUI form messages synchronously, without mutating prior state or running operations.
 * @param {object} overlay Form state. Non-form state returns unhandled unchanged.
 * @param {object} message GTUI input.change/input.submit/menu.select/menu.change/menu.cancel/action.select/toolbar.change/scroll.change or normalized key message.
 * @returns {{overlay:object,handled:boolean,submit?:{action:object,values:object},cancel?:true}} Submission sets busy and returns a fresh values snapshot; busy consumes edits/duplicate saves, but cancellation stays available. Editor/choice Enter advances, never implicitly submits; custom choice Enter opens text editing in place. Only the final Save action or Ctrl+S submits. Tab/Shift+Tab cycle fields and actions. Escape/Ctrl+C cancel (Escape returns from the explanation reader). GTUI handles Shift+Enter for multiline fields; single-line values normalize line breaks to spaces.
 * @throws {TypeError} Malformed form state may fail; invalid messages are ignored.
 * Parent integration: bind Tab, Shift+Tab, Escape, Ctrl+C, Ctrl+S before GTUI controls (menus otherwise swallow shortcuts); intercept these messages before normal app handlers and persist the returned overlay. Consume handled messages. Run submit.action with submit.values. Capture the returned busy overlay as the operation identity; apply async completion/formErrors ONLY if the current overlay is still that same object. Cancel restores back or closes the overlay; stale completion must never navigate a future UI. Unhandled background messages may continue to the main reducer. Never log form state/messages containing secret values.
 */
export function updateForm(overlay, message) {
  const unchanged = { overlay, handled: false };
  if (overlay?.type !== "form" || !message || typeof message !== "object") return unchanged;
  if (overlay.reading && !overlay.busy) {
    if (message.type === "scroll.change" && message.id === DETAILS_ID) return { overlay: { ...overlay, detailsOffset: message.offset }, handled: true };
    if (message.type === "key" && message.key === "ctrl+c") return { overlay, cancel: true, handled: true };
    if ((message.type === "key" && ["escape", "tab", "shift+tab"].includes(message.key)) || (message.type === "action.select" && message.action === BACK)) {
      return { overlay: { ...overlay, reading: false }, handled: true };
    }
    return { overlay, handled: ["key", "scroll.change", "action.select"].includes(message.type) };
  }
  if (message.type === "key") {
    if (["escape", "ctrl+c"].includes(message.key)) return { overlay, cancel: true, handled: true };
    if (message.key === "ctrl+s") return submitForm(overlay);
    if (message.key === "tab" || message.key === "shift+tab") {
      if (overlay.busy) return { overlay, handled: true };
      const count = overlay.fields.length + 1;
      const step = message.key === "shift+tab" ? -1 : 1;
      return { overlay: { ...overlay, focus: (overlay.focus + step + count) % count }, handled: true };
    }
    if (message.key === "enter" && !overlay.busy) {
      if (overlay.focus === overlay.fields.length) {
        if (overlay.menuIndex === 1) return { overlay, cancel: true, handled: true };
        if (overlay.menuIndex === 2) return { overlay: { ...overlay, reading: true }, handled: true };
        return submitForm(overlay);
      }
      const field = overlay.fields[overlay.focus];
      const choice = choiceState(overlay, field);
      if (field.options.length && !choice.custom) return choiceUpdate(overlay, overlay.focus, choice.index, true);
      return { overlay: { ...overlay, focus: overlay.focus + 1 }, handled: true };
    }
    if (!overlay.busy && ["up", "down"].includes(message.key)) {
      const field = overlay.fields[overlay.focus];
      if (field?.options.length) {
        const current = choiceState(overlay, field);
        const step = message.key === "up" ? -1 : 1;
        const selected = current.custom ? (message.key === "up" ? field.options.length - 1 : 0)
          : (current.index + step + field.options.length + Number(field.custom)) % (field.options.length + Number(field.custom));
        return choiceUpdate(overlay, overlay.focus, selected, false);
      }
    }
    // Unused modal keys must never trigger a main-app action behind the form.
    return { overlay, handled: true };
  }
  if (message.type === "input.change" || message.type === "input.submit") {
    const index = overlay.fields.findIndex((field) => message.id === FORM_INPUT_PREFIX + field.name);
    if (index < 0) return unchanged;
    if (overlay.busy) return { overlay, handled: true };
    const next = inputUpdate(overlay, index, message);
    return { overlay: message.type === "input.submit" ? { ...next, focus: index + 1 } : next, handled: true };
  }
  const choiceIndex = overlay.fields.findIndex((field) => field.options.length && message.id === FORM_INPUT_PREFIX + field.name);
  if (choiceIndex >= 0 && ["menu.change", "menu.select", "menu.cancel"].includes(message.type)) {
    if (message.type === "menu.cancel") return { overlay, cancel: true, handled: true };
    if (overlay.busy) return { overlay, handled: true };
    const field = overlay.fields[choiceIndex];
    const current = choiceState(overlay, field);
    const query = message.query ?? current.query ?? "";
    if (message.type === "menu.change" && message.reason === "filter") {
      const matching = matchingChoices(field, query);
      const index = matching.some((entry) => entry.index === current.index) ? current.index : matching[0]?.index ?? field.options.length;
      return { overlay: { ...overlay, focus: choiceIndex, choices: { ...overlay.choices, [field.name]: { ...current, index, query } } }, handled: true };
    }
    if (message.item?.value?.type !== CHOICE) return { overlay, handled: true };
    const next = { ...overlay, choices: { ...overlay.choices, [field.name]: { ...current, query } } };
    return choiceUpdate(next, choiceIndex, message.item.value.index, message.type === "menu.select");
  }
  if (message.type === "action.select") {
    if (message.action === CANCEL) return { overlay, cancel: true, handled: true };
    if (message.action === SUBMIT) return submitForm(overlay);
    if (message.action === DETAILS) return { overlay: overlay.busy ? overlay : { ...overlay, reading: true }, handled: true };
  }
  if (message.type === "menu.cancel" && (message.id === undefined || message.id === FORM_MENU_ID)) return { overlay, cancel: true, handled: true };
  if (message.type === "scroll.change" && ["form-before", "form-after", DETAILS_ID].includes(message.id)) return { overlay, handled: true };
  if (message.id !== FORM_MENU_ID) return unchanged;
  if (message.type === "toolbar.change") {
    if (overlay.busy) return { overlay, handled: true };
    return { overlay: { ...overlay, focus: overlay.fields.length, menuIndex: message.action === CANCEL ? 1 : message.action === DETAILS ? 2 : 0 }, handled: true };
  }
  const type = message.item?.value?.type;
  if (message.type === "menu.select") {
    if (type === CANCEL) return { overlay, cancel: true, handled: true };
    if (type === SUBMIT) return submitForm(overlay);
    if (type === DETAILS) return { overlay: overlay.busy ? overlay : { ...overlay, reading: true }, handled: true };
  }
  if (message.type === "menu.change") {
    if (overlay.busy) return { overlay, handled: true };
    return { overlay: { ...overlay, focus: overlay.fields.length, menuIndex: type === CANCEL ? 1 : 0 }, handled: true };
  }
  return unchanged;
}

/**
 * Return an editable form after parent validation/operation failure, retaining every entered value.
 * @param {object} overlay Borrowed form state; no inputs are mutated.
 * @param {object|string} errors Field-name-to-message map (or arrays of messages); `_form` is a general error. A string is a general error. Unknown names are ignored.
 * @returns {object} New state with busy false and focus on the first invalid field; errors are copied/stringified. Rendered errors redact current secret values.
 * @throws {TypeError} Errors must be a string or non-null, non-array object. String conversion errors propagate. Retrying with the same errors is safe.
 * Only call for an operation if the current overlay still matches its captured busy overlay; this helper does not own asynchronous lifetimes.
 */
export function formErrors(overlay, errors) {
  if (typeof errors === "string") errors = { _form: errors };
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) throw new TypeError("form errors must be a map or string");
  const allowed = new Set(["_form", ...overlay.fields.map((field) => field.name)]);
  const entries = Object.entries(errors).filter(([name, value]) => allowed.has(name) && value !== undefined && value !== null && value !== "");
  const copied = Object.fromEntries(entries.map(([name, value]) => [name, Array.isArray(value) ? value.join(" · ") : String(value)]));
  const first = overlay.fields.findIndex((field) => Object.hasOwn(copied, field.name));
  return { ...overlay, errors: copied, busy: false, focus: first < 0 ? overlay.focus : first };
}
