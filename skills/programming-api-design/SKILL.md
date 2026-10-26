---
name: programming-api-design
description: "This skill should be used when designing or reviewing local APIs for modules, libraries or functions; not HTTP/REST or OpenAPI."
---

# API Design

Deliver APIs as signatures with contract comments, plus happy-path, error-path and composition examples.

## Units

- Give each unit one responsibility. If describing it needs "and", split it.
- Build features by composing small units. Options may tune one behavior; give distinct behaviors their own functions instead of switching modes inside one.
- Keep one implementation per behavior; reuse it instead of copying logic between units.
- Callers use public contracts only, never another unit's internal state or helpers.

## Contract

- Every public symbol documents: preconditions, ownership and lifetime of inputs and outputs, side effects, idempotency, complexity when not obvious, and each failure (condition, caller action, retry safety).
- Use one error strategy per layer, following the language skill; never mix throwing and result values for the same failure class.
- Separate commands from queries: queries never mutate; retryable commands are idempotent.
- Keep the surface minimal: private by default; export only what callers need.
- Default to safe behavior: least privilege, validated input at the boundary, opaque handles over exposed internals.
- Don't over-engineer. Not every edge case is relevant. Example: if system is out of memory you have bigger problems than code correctness.

## Naming

- Order name parts from general to specific: the thing acted on first, the action last (`<subject><action>`). Nest further subjects the same way (`<module><subject><action>`).
- Spell names in the project's or language's case and separator style; the word order stays the same: `tableBuild`, `table_build`, `table.build`, `note-create`/`note-destroy`.
- Keep names whose form the language or a framework requires, such as constructors, operator hooks and interface methods.

## Signatures

- Take 0–3 positional arguments; move optional settings into an options struct or object. Order: subject or context first, required before optional, inputs before outputs, options last.
- Symmetric pairs share names and argument order (`file.read`/`file.write`, `File.open`/`file.close`, `poolInit`/`poolDestroy`).
- Make every call site state its meaning: replace positional flags with named options or separate functions (`render(doc, { draft: true })` or `draftRender(doc)`, not `render(doc, true, false)`).
- Type a multi-valued mode with the language's checked form, not free strings: an enum in C or Zig, a string-literal union in TypeScript, a documented string set validated at entry in JavaScript.
- Distinguish adjacent same-type parameters with named fields (`copy({ src, dst })`) or, in typed languages, distinct types (`UserId`/`GroupId`).
- Return the useful value so calls compose; return a struct for multiple values.

## Evolution

- Never add a required parameter, remove a field or narrow accepted input in a published API. Add optional fields with defaults; put new required behavior in a new function.
- Deprecate before removal; state the replacement and removal version.
- Treat added struct fields, enum values and return fields as non-breaking only when callers are documented to tolerate them (zero-initialized structs, `default`/`else` branches).

