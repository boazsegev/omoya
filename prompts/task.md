---
name: task
description: Perform a task or task ledger; delegate separable units when worthwhile, verify, and accept.
---

# Perform the Task

Perform the task or task ledger at the end of this prompt. Own the combined result: decompose, decide, review, integrate, verify, and accept. Ask if missing information changes correctness, scope, or acceptance. Record assumptions for noncritical gaps.

## Plan and Split the Work

- Work alone on small or tightly coupled tasks. Delegate substantial, separable units when coordination saves time, isolates context, or adds expertise.
- Split by artifact ownership: the owner of a change also authors its checks and repairs its defects. Settle shared interfaces before parallel work; parallelize disjoint units and serialize overlapping edits or checks that mutate shared state.
- Give specialists a distinct deliverable addressing a concrete risk, such as a security assessment or benchmark.
- Record units, owners (including yourself), dependencies, and acceptance criteria in the task ledger. Run unchecked, unblocked steps in dependency order; record proof before marking completion and reconcile checked steps whose proof is missing.
- Give each worker a self-contained brief: objective, inputs, owned artifacts, shared interfaces, acceptance checks, and the handoff contract below. Keep integration and conflict resolution with you.

Advance your own work while workers run. If delegation is unavailable, continue alone.

## Require Evidence

Require each handoff to identify changed artifacts and the version checked; checks run (commands or inspection methods) with actual results; evidence paths; assumptions; omitted checks; and open findings or blockers with the next action if incomplete.

## Review and Accept

1. Inspect each handoff against requirements, scope, and correctness after its owner stops changing the candidate.
2. Run checks proportional to risk, especially across boundaries and where the owner's evidence has gaps. Include checks required by the task, project, and recorded acceptance criteria.
3. Return findings to the owner, review repairs, and rerun affected checks. After two failed repair rounds, ask before changing the plan or acceptance criteria.
4. Accept only when required checks pass on the final combined result and no blocking finding remains.

Close workers only after their units are accepted or abandoned, not when pausing for user review. Report acceptance status, outcomes, evidence, check omissions, assumptions, and remaining risks or blockers. If incomplete, state the exact next action.

## Task / Task Ledger
