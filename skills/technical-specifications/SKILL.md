---
name: technical-specifications
description: "This skill should be used when writing, reviewing, or fixing a technical document such as a specification, design doc, implementation plan, requirements set, or decision record; not general prose style or code-level API reference."
---

# Make Technical Documents Implementable and Verifiable

## Establish the Document's Contract
- Identify the document type, audience, what it decides or defines, and which parts are normative versus informative. Ask when an unknown type or audience would change the structure.
- Match depth to the cost of reversing the decision: a few lines for a small, reversible change; full sections for hard-to-reverse or cross-team work.
- Follow the project's or publishing venue's template when one exists. Otherwise, use the sections below.
- Decision records: one decision per record covering context, decision, and consequences. Supersede accepted records instead of rewriting them.

## Include Sections Only When They Carry Content
- Problem and context, measurable goals, and non-goals with the reason each is excluded.
- Terminology for project-specific or ambiguous terms only.
- Requirements or behavior, then design: components, interfaces, data, states, and flows.
- Alternatives for each hard-to-reverse decision, each with its rejection reason.
- Errors: what each failure produces, whether it can be retried, and how state recovers.
- Security: trust boundaries, assets, mitigated threats, excluded threats with reasons, and residual risk. A claim of "no security impact" needs a justification.
- Compatibility: who breaks, the migration path, and the deprecation timeline. Add rollout and rollback when the work is deployable.
- Assumptions, open questions, and references, separating those needed to implement from background reading.

## Write Testable Requirements
- State one obligation per statement and give it a stable ID or anchor.
- Name the actor, the condition or trigger, and an observable response: "When/While/If <condition>, <component> shall <response>." Specify the mechanism only when it is itself a constraint.
- Replace vague qualities (fast, secure, scalable, robust, large, intuitive, many) with a threshold, unit, and load condition, or with a named mechanism. For example, "handle large files" becomes "accept uploads ≤100 MB; reject larger ones with error `too_large`."
- Cover prohibitions, defaults, boundaries (empty, maximum, invalid, concurrent), and partial failure.
- If the document uses normative keywords, define them once and apply them consistently. Reserve the strongest level for correctness, interoperability, safety, and security. Give a reason for each permitted exception to a recommendation, and define behavior both with and without each optional feature.

## Keep One Source of Truth
- Define each term, limit, field, and error code once and reference it elsewhere. Use one name per concept.
- Put enumerable facts in tables and flows or state machines in diagrams. Do not restate them in prose.
- Give a realistic example for each message, format, and algorithm, including at least one error case. When an example conflicts with the normative text, fix the example or state which one takes precedence.

## Review and Fix
- Check in this order, because earlier gaps invalidate later fixes: contract; correctness (contradictions, undefined terms, broken references, mismatched examples, missing boundary or failure behavior); testability; required sections; concision (delete filler, restatement, and explanations of well-known concepts).
- Report each finding with its location, the issue, its consequence, a concrete fix, and a severity of blocking, should-fix, or nit.
- When fixing, edit in place and preserve the author's decisions. List missing decisions as open questions instead of inventing answers.
- Finish when all checks pass and every unresolved item is listed as an open question.
