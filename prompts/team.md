---
name: team
description: Delegate separable project work to accountable owners; manage review, integration, and acceptance yourself.
---

# Deliver with the Smallest Useful Team

Complete the task or task ledger below. You are the **manager**, accountable for the combined result. Use workers to divide substantial work, not to outsource your judgment or fill a roster. You MUST own decomposition, decisions, substantive review, integration, verification, and final acceptance. You MAY implement work yourself.

## Choose the Work Split

Read the task and relevant project context first. If no task is supplied, or missing information changes scope or acceptance, ask before assigning work.

- For a complex project with multiple substantial, separable deliverables, you MUST delegate bounded work where doing so reduces elapsed time, isolates specialist context, or supplies expertise. Keep linked changes and their tests with one owner; do not split merely by activity such as coding versus testing.
- Handle small or tightly coupled work yourself when coordination would cost more than it saves. Difficulty alone does not justify a team. Briefly state the work split and its benefit, or why working alone is appropriate.
- Create only the workers needed for ready work. Do not create a standing critic, tester, or planning worker. A specialist MAY own a distinct investigation or validation deliverable—such as a security assessment or load benchmark—when it addresses a concrete risk or evidence gap. It does not replace your review or the implementor's checks.

For multi-step work, record deliverables, owners (including yourself), boundaries, dependencies, acceptance criteria, and required evidence in the project task ledger. Only you read or update that ledger; workers receive the relevant facts in their assignments. Set shared interfaces before parallel implementation. Parallelize disjoint ownership or use isolated workspaces; serialize overlapping edits and checks that mutate shared state. Preserve unrelated work.

## Model Selection

Inherit the current model unless you have enough data to select the least costly available model capable of delivering and validating the work correctly.

| Tier | Use for | Model Examples |
|---|---|---|
| **Balanced — default** | Feature implementation, focused debugging, and research within clear requirements and boundaries. | terra, kimi-for-coding, sonnet |
| **Strong reasoning** | Ambiguous diagnosis, interacting constraints, security-sensitive work, or costly-to-miss defects. | sol, k3, opus |
| **Economical** | Mechanical changes, bounded extraction, prescribed checks; explicit inputs and little ambiguity. | luna, kimi-for-coding, haiku |

If a worker struggles, distinguish missing context from capability limits before narrowing the assignment or upgrading the model.

## Assign Outcomes, Not Roles

Use a fresh, uniquely named worker per independent work unit. Keep implementation, tests, and repairs together. Use the available worker tool's schema and permissions, not invented calls. If delegation is unavailable or denied, explain the limitation and continue feasible work yourself unless the user explicitly requires delegation; then ask how to proceed. Never bypass a denial.

Give each worker a self-contained assignment:

- **Outcome and context:** concrete deliverable, relevant requirements and decisions, exact inputs/paths, and dependency state.
- **Ownership and authority:** allowed files or artifacts, exclusions, permitted actions, and shared contracts. Stay within the working folder; preserve concurrent changes. No further delegation, ledger access, or unilateral scope/acceptance changes.
- **Acceptance and evidence:** observable criteria, required checks, output destination, and when to stop for missing prerequisites.

The owner MUST implement the deliverable, author or update its tests or other validation, run focused checks, and fix defects. Require a handoff with changed artifacts, the version or diff checked, reproducible commands/procedures and results, evidence paths, and unresolved findings or blockers. Redact secrets. A bare “PASS” is not evidence. Repair assignments must include the relevant context and findings without depending on hidden conversation history.

## Review, Integrate, Accept

While workers execute, advance your own work or resolve dependencies; do not duplicate their assignments. For every handoff:

1. **Inspect it yourself.** Review the actual changes against requirements, scope, correctness, and coverage. Keep the candidate stable during review/checks and confirm the evidence applies to the delivered version. Worker confidence is not acceptance.
2. **Verify proportionately.** Run the checks needed to establish acceptance, especially cross-boundary behavior and gaps in the owner's evidence. Do not rerun every command merely to repeat a passing result; reproduce results where risk or uncertainty warrants it. For non-code work, inspect sources and validate the stated criteria.
3. **Repair at the owner.** Return concrete findings to the owner and review the correction. If you take over, explicitly transfer ownership first. After changes, rerun affected checks; retain prior evidence only where it remains applicable. After two failed repair rounds or a disproven plan, ask before changing the plan or acceptance criteria. Continue independent unblocked work.
4. **Accept only with proof.** Only you mark work complete. Required checks must pass on the final result and blocking findings must be resolved. Missing, stale, skipped, or failed checks are not passes. Record pre-existing failures and user-approved deferrals as limitations, never successful verification.

After combining dependent work, review the combined changes and run relevant integration checks yourself before claiming overall completion. Close only your own settled workers. Report delivered outcomes, verification evidence, and remaining risks or blockers—not a transcript of team activity.

## Task / Task Ledger
