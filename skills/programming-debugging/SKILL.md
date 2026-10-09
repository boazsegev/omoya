---
name: programming-debugging
description: "This skill should be used when debugging a failure, reproducing a bug, minimizing a failing case, testing falsifiable hypotheses, finding the first divergence, or proving root cause."
---

# Debugging

## Rules

- Fix root causes, not symptoms.
- Reproduce the failure with a failing test or isolated command before changing production code. If reproduction fails, say so and keep investigating.
- Change one variable per experiment.
- Blame a compiler, OS, runtime or dependency only after a minimal standalone reproduction outside project code.
- Match wording to evidence:

| Evidence | Allowed wording |
|---|---|
| code reading | "hypothesis", "may be related" |
| tool warning | "flagged by <tool>" |
| failing test or command | "confirmed failure in <area>" |
| isolated reproduction + traced cause | "root cause is" |

## Workflow

1. **Establish the failure.** Record repro steps, command, environment, expected vs actual output, logs and stack trace. Confirm it fails consistently; for flaky failures, record the failure rate.
2. **Minimize.** Remove input, code or configuration in chunks, re-running after each removal; stop when removing anything makes it pass. Use a delta-debugging reducer when available.
3. **Collect leads.** Run the project's sanitizers, type checkers, linters and property/fuzz tests on the minimal case. Tool output is a lead until reproduced.
4. **Hypothesize.** Write 2–4 falsifiable hypotheses, each naming the code, condition and observable divergence:
   `Hypothesis: <cause>` / `Prediction: <observable if true>` / `Experiment: <single command or probe>`.
5. **Experiment.** Run one experiment per hypothesis: isolation test, instrumentation at suspected divergence, passing-vs-failing trace comparison, or a toggle in a disposable copy. Record command, output and verdict.
6. **Localize.** Find the first state divergence between passing and failing runs; slice backward from the failing assertion through data and control dependencies. With many tests, rank statements by pass/fail correlation (Ochiai).
7. **Diagnose.** Explain why the minimal case fails, why nearby cases pass, which invariant is violated, and why the other hypotheses were rejected. Common roots: boundaries, empty/null, conversions, wrong operator, stale or uninitialized state, races, resource lifetime, API contract misuse.
8. **Fix and verify.** Patch only the root cause. Then: the minimal case passes; a regression test fails before and passes after the fix; relevant existing tests pass; boundary edge cases pass; add a property/fuzz test when a class of inputs is implicated.
