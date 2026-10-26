---
name: ai-tool-writing
description: "Use to design or review agent-callable tools (harness, MCP, function schemas); not library APIs or skills."
---

# Write Agent Tools

## Split

- One action per tool, named `<subject>-<action>` (`worker-create`), not `worker(action: "create")`.
- Fit agent tasks, not endpoints (`logs-search` over `logs-read`); merge always-chained steps.
- Inject known context (cwd, agent, session). Separate read-only from mutating tools.

## Schema

- Closed objects (`additionalProperties: false`). Nest only for a list of same-shape items (`edits: [{oldText, newText}]`), never as option wrappers. `required` lists only what the action cannot run without.
- One type per field; no combinators, type arrays or mixed forms. Two shapes are two tools.
- Enums for closed sets; split behavior-changing modes into tools.
- Explicit, consistent names (`user_id`, `timeout_ms`). State defaults. Bound output with `limit`/`offset`.
- Intended inputs only.

## Parse

- Normalize in one entry pipeline: strict schema, liberal parser.
- Infer intent: lone value to array, numeric/boolean/JSON strings to values, enum case, relative paths, defaults, unique prefixes.
- Error only when no single reading exists: missing required value, conflict, ambiguous match. Destructive actions require exact targets.
- Errors teach: received value, valid form or candidates, next call.

## Describe

- Each description is a short skill: what it does, when to pick it over neighbors, input meaning, effects, limits, likeliest mistake. One to three sentences.
- Parameter descriptions add only format, units, example or default.
- Fix misuse in descriptions or errors first.

## Return

- Names and next-step facts; IDs only when a follow-up call needs them.
- Confirm mutations (target, count); never return empty.
- On truncation, state how to get more.

## Verify

- Run realistic tasks through a model; check transcripts for wrong tool, bad arguments, retries.
- Test schema shape, each normalization and each error text.
