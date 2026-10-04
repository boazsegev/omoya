---
name: ai-skill-authoring
description: "Use for any AI skill authorship, such as when creating, revising, validating, or publishing reusable AI skills; not one-off prompts, ordinary task execution, tool implementation, or agent identity."
---

# Write Skills using Reusable Actionable Instructions

Create reusable instructions that change an executor's decisions. Follow the requested scope, format and permissions. For review-only work, return findings and suggestions; for draft-only work, return uninstalled content.


## Focus the Skill's Scope To One Actionable Concern

- Target a requested or demonstrated recurring intent. Inspect existing skills; revise the existing owner when appropriate.
- Keep one-off requests in prompts, task state in memory, identity/authority in agent instructions, and executable capability in tools.
- Define activation intent, relevant adjacent exclusions, required decisions and output. Ask if the domain or behavior is unknown.
- Before drafting, define normal, failure, missing-input and adjacent-routing cases within that intent. Compare with no-skill behavior when available.
- Before revising, identify a concrete defect or changed requirement. Preserve established intent, prerequisites, authority and completion behavior unless their change is requested. Leaving working instructions unchanged is valid.

## Write Instructions That Affect Execution

- Use concise imperative rules for missing domain knowledge: definitions, schemas, branches, formulas, standards, corrections and output fields.
- Specify actions positively. Use negative constraints only for user/project requirements or concrete execution ambiguities.
- Ask when missing inputs change correctness, compatibility, scope or authority; label noncritical assumptions. Clarify relevant permissions; skills cannot grant tools or approval.
- Use MUST for invariants, SHOULD for defaults and MAY for options. Give exact procedures for fragile operations; allow judgment elsewhere. Replace "validate carefully" with a check: "If order_id is absent, reject before writing." Add examples only for likely mistakes.
- Verify consequential claims against primary sources or project contracts; keep research and validation records outside the skill. Remove generic coaching, repeated policy, rationale, authorship evidence, citations and task history.
- The main file should be under 4 KB and 60 lines, with 8 KB and 100 lines as a soft limit for complex skills. Keep routinely needed instructions in the main file.
- Require no sibling load. Link resources directly for explicit deep sub-intents and state when to read them. Document script dependencies and side effects; test scripts before use.

## Check Relevance and Completeness

- Use focused actionable titles that help the executor find instructions.
- Retain paragraphs that supply necessary input, resolve an ambiguity or preserve a requirement. Remove instructions whose deletion leaves intended behavior unchanged.
- Exclude unrelated context and scenarios outside the activation intent.
- Check that a fresh executor can identify activation, actions, inputs, limits and completion criteria from the skill and its stated inputs.

## Package and Publish the Skill

Use the user/project skills-folder.

For SKILL.md format, use `<skills-folder>/<name>/SKILL.md` with required scalar frontmatter:

```yaml
---
name: domain-topic
description: "This skill should be used when [specific intent]; not [adjacent intent]."
---
```

- Match name to directory: 1–64 lowercase letters/digits/hyphens, no edge or consecutive hyphens. Use a specific third-person description of 25–500 characters (hard limit: 1023).
- Draft outside the skills-folder; preserve prior versions and concurrent edits. Before publishing, check scope, format, claims, links, dependencies and representative cases. On rename, update callers and reconcile moved rules before deletion.
- Publish checked content. Report path, byte size, assumptions and unresolved issues. Separate structural checks from behavior tests; state checks run/unrun and the next action if incomplete.
