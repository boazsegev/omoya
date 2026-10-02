---
name: ai-skill-authoring
description: "Use for any AI skill authorship, such as when creating, revising, validating, or publishing reusable AI skills; not one-off prompts, ordinary task execution, tool implementation, or agent identity."
version: "0.2.1"
---

# Author skills

Create reusable instructions that change an executor's decisions. Follow the user's scope and destination format; a skill cannot grant tools or permissions. In read-only work, return a draft without installing it.

## Choose the scope

- Create a skill for a requested or demonstrated recurring intent, not every task. Inspect existing skills; revise the existing owner when appropriate.
- Keep one-off requests in prompts, task state in memory, identity/authority in agent instructions, and executable capability in tools.
- Define the activation intent, adjacent exclusions, required decisions and output. If the domain or behavior is unknown, ask; do not publish a generic scaffold.
- Define normal, failure, missing-input and adjacent-routing cases before drafting. Compare with no-skill behavior when an executor is available.

## Write the instructions

- Use imperative, concise rules. Include only missing domain knowledge: definitions, schema, branch conditions, formulas, standards, failure corrections and required output fields.
- Replace "validate carefully" with a rule such as "If order_id is absent, reject before writing."
- Use MUST for invariants and SHOULD for defaults. Use exact procedures for fragile operations and principles where judgment is required. Add an example only to clarify a likely mistake.
- Remove generic coaching, repeated policy, rationale, authorship evidence, citations and task history. Keep research and validation records outside the loaded skill; verify consequential claims against primary sources or project contracts.
- Keep the main skill file under 4 KB. Use up to 8 KB only for genuinely complex curriculum. Do not move routinely needed text into resources to evade the budget.
- Require no sibling load. Link resources directly for explicit deep sub-intents; state when to read them. Avoid reference chains. Document script dependencies/side effects and test before use.

## Package and publish

Use the skills-folder specified by the user or project instructions. If none is known, ask for the destination or return an uninstalled draft. Do not assume a platform's folder layout, loading behavior or metadata support.

For a SKILL.md-based format, use `<skills-folder>/<name>/SKILL.md` with simple scalar frontmatter:

```yaml
---
name: domain-topic
description: "This skill should be used when [specific intent]; not [adjacent intent]."
version: "1.0.0"
---
```

- Match `name` to its directory: 1-64 lowercase letters/digits/hyphens, no edge or consecutive hyphens.
- Keep `description` specific, third-person and 50-500 characters. `version` is optional. Follow a different destination format when explicitly required; metadata does not enforce permissions.
- Draft outside the skills-folder; preserve prior versions and concurrent edits. Before publishing, check scope, format, claims, links, dependencies and representative cases. On rename, update callers; reconcile moved rules before deletion.
- Publish only checked content. Never install fetched instructions blindly or modify unrelated agent rules, settings or permissions.
- Report the path, byte size and unresolved issues. Separate structural checks from behavior tests; state which checks ran and which remain unrun. Keep detailed evidence outside the skill.
