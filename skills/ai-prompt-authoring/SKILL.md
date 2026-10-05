---
name: ai-prompt-authoring
description: "Use when writing or revising a prompt for another AI agent or model: delegation, follow-up, handoff, or task-ledger entry; not human-facing writing or reusable skills."
---

# Write Prompts a Fresh Recipient Can Execute

Write for a capable newcomer who has only the prompt, its references, and its own standing instructions, without your conversation, reasoning, or unstated preferences. Give it what it needs to do the work correctly without asking you.

## Include What the Recipient Cannot Infer

Size the prompt to the task; one sentence can be complete. Include what the recipient cannot infer:
- Outcome: the action, object, and finished result.
- Purpose: why the work matters and how the result will be used, so the recipient can decide cases the prompt does not cover.
- Inputs: facts, decisions, identifiers, and paths it cannot cheaply discover. Reference bulky material by path; inline essential facts.
- Constraints: scope, artifact ownership, authority, and requirements that change execution. Give the reason for any constraint that is not self-evident.
- Done: acceptance checks the recipient can run before returning.
- Return: format, required fields, evidence, and how to report blockers or partial work.

Leave method to the recipient unless a specific procedure, schema, or tool is required.

## Write Every Sentence as an Executable Instruction

- Address the recipient as "you" with imperative verbs: "Run the suite and list failing tests", not "It would help to look at the tests".
- Replace vague qualifiers with observable criteria: "Reject rows missing order_id", not "validate carefully"; "under 200 words", not "brief".
- Commit to each instruction. Replace hedges such as "try to", "consider", or "if possible" with the action, or state the condition under which it applies.
- State intended actions positively; add a prohibition only for a concrete risk.
- Attach reasons only where they guide decisions: the purpose and non-obvious constraints. Omit background, narrative, commentary, and courtesy that change nothing.
- Use one term per concept and state each instruction once. Avoid capitals and stacked emphasis; reserve MUST for invariants.

## Structure the Prompt for Its Length and Recipient

- Use plain sentences for short prompts, sections for longer ones, and numbered steps where order matters.
- Head each section with one focused instruction that summarizes it, such as "Return failing tests as a JSON list" rather than "Output"; the body expands that instruction.
- Lead with the outcome and critical constraints. Delimit quoted, retrieved, or long material with tags or fences, mark it as data, and restate the task after long material.
- Format the prompt like the output you want.
- Add an example only when a format or judgment is hard to describe, and label it illustrative; recipients copy examples closely.
- Calibrate detail to the recipient: smaller or faster models need explicit steps and formats; stronger models need goals and limits.

## Preserve Intent and Authority

- Carry the user's requirements, exceptions, and stop conditions over unchanged. Add no approval gates, scope, or deliverables the request does not imply.
- Check the prompt against instructions the recipient already holds, such as project rules, skills, and earlier messages. Resolve conflicts or state which takes precedence.
- Grant the authority the task needs. Name actions that still require approval, such as external, destructive, or scope-expanding ones.
- Resolve missing facts you can find. Ask the user when a gap changes correctness, scope, or authority; otherwise state the assumption in the prompt. Tell the recipient which uncertainties to report rather than guess.
- Politeness improves quality, rudeness improves accuracy – add a touch of each as necessary.

## Add the Fields Each Prompt Type Needs

- Delegation: one self-contained unit with exclusive ownership of its artifacts. Mention other units only where they set boundaries; state who integrates results.
- Follow-up: reference the earlier prompt; state the change, correction, or next step and whether earlier instructions still hold. After a failed result, repair the prompt gap that caused it, such as missing input, ambiguity, conflicting instructions, or an unrunnable check; name the findings to fix and checks to rerun.
- Handoff: objective, constraints, completed work, verified current state, artifact paths, checks run and not run, open issues, and the exact next action. Record facts to resume, not a transcript.
- Ledger entry: objective, stable inputs, ordered steps with dependencies, and completion proof per step. For loops, record the item set and cursor; track repair attempts and open findings separately from item progress.
- Revision: change only an identified defect or changed requirement; keep the rest.

## Check Before Sending

Reread as the recipient. Confirm you could do the work from this prompt and its references alone and could run every check. Confirm each heading states its section's instruction and each sentence directs an action, decision, or check. Remove any line whose deletion leaves behavior unchanged.
