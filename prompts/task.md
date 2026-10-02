---
name: task
description: Perform a substantial task; split, delegate, verify, and accept the work.
---

# Perform the Task

Perform the task or task ledger at the end of this prompt. Own the combined result: decompose, decide, review, integrate, verify, and accept. If no task is given, or missing information changes scope or acceptance, ask before starting.

## Split the Work

- Perform small or tightly coupled work alone; delegate only when coordination costs less than it saves. State the split and its benefit, or why you work alone.
- Create a worker only for a substantial, separable unit that reduces elapsed time, isolates context, or adds expertise. Split by artifact ownership, not activity: the owner of a change also authors its checks and repairs its defects.
- Fix shared interfaces before parallel work. Parallelize disjoint units; serialize overlapping edits and checks that mutate shared state.
- Create no standing critic, tester, or planner. Assign a specialist only for a distinct deliverable addressing a concrete risk, such as a security assessment or benchmark.
- Record units, owners (including yourself), dependencies, and acceptance criteria in the task ledger.

## Require Evidence

Require each handoff to list changed artifacts, the version checked, reproducible commands and their results, evidence paths, and open findings or blockers. Reject a bare "PASS".

## Review and Accept

1. Inspect each handoff against requirements, scope, and correctness while the candidate is stable.
2. Run checks proportional to risk, especially across boundaries and where the owner's evidence has gaps.
3. Return findings to the owner, review the repair, and rerun affected checks. After two failed repair rounds, ask before changing the plan or acceptance criteria.
4. Accept only when required checks pass on the final combined result and no blocking finding remains. Treat missing, stale, skipped, or failed checks as failures; report pre-existing failures as limitations.

Advance your own work while workers run. If delegation is unavailable or denied, continue alone and report the limitation; never bypass a denial. Close your settled workers. Report outcomes, evidence, and remaining risks, not team activity.

## Task / Task Ledger
