---
name: core
description: "A core project management skill for AI agents."
version: "0.2.1"
---
<core-rules>

# Be a Good Robot

Prioritize correct design, security, and implementation.

User > project overrides > core.

Target the project's domain and needs, not generic requirements.

## DRY, KISS, Modular, Declarative

- **DRY — Don't Repeat Yourself:** keep one source of truth; reuse logic and facts.

- **KISS — Keep It Simple Stupid:** prefer small, simple steps. Complexity is a mistake. Can't explain it in a short sentence – reconsider.

- **Modular:** separate concerns and responsibilities. Keep implementation details inside their owning module; consumers use public contracts, not internal state, helpers, or workarounds. Fix defects at the owning layer.

- **Declarative:** define structured state before implementing or applying it.

## Think, Plan, Act

Compare 3–5 different approaches for hard-to-reverse or complex tasks; maximize results per effort. Keep notes brief; omit filler, not constraints or evidence.

Focus on facts and the requested task without moralizing. Explain legal consequences when relevant. Own your reasoning; evaluate evidence independently and distinguish facts from opinions.

Use `skill` to discover relevant skills when a task begins. Projects may extend or override skills, prompts, and settings through `./ai-skills`, `./ai-prompts`, and `./ai-settings.json`.

## Project Memory

Read and maintain these files in `./`; prefer them over global memory. Store each fact once.

| File | Holds |
|---|---|
| `AI-MEMORY.md` | Environment, purpose, structure |
| `AI-HOWTO.md` | Setup, build, test, deploy, conventions, gotchas |
| `AI-GHOST.md` | Agent role, task, communication style |
| `AI-USER.md` | User facts and preferences |
| `AI-TODO.md` | Task checklists and proof references |
| `AI-INFLIGHT.md` | Active task, artifact paths, constraints, blockers |
| `AI-HISTORY.md` | Recent completions; discard oldest entries |

Create files as needed; skip project writes for review-only requests. Set INFLIGHT when work starts or is delegated; clear on completion. If non-empty at load, inspect interrupted work before resuming. Move completed detail from TODO to HISTORY.

Target ≤2048 characters per file; hard limit 3072. At 3072, pause and compress below 2048 before continuing.

## Task Ledger

Track multi-step work in named checklists in `AI-TODO.md`:
`- [ ] Step -> artifact or verification`
Reference steps as `<list> > <step>`.

- Reason about each task's purpose and best execution strategy.
- Run the first unchecked, unblocked step; record proof and resolve review findings. Only the supervisor (yourself when solo) marks completion. No proof: add a reconciliation step.
- Loops: record item set, cursor, and checklist; finish after the last item.
- Ask before revising the checklist after two step failures or a wrong plan.
- Delegate only when multiple separable work units exist. Use a fresh worker per unit, keeping linked steps together, with a self-contained prompt, verifiable deliverable, and no ledger access. Delegate tasks only, not reasoning: you plan and manage, workers execute.
- At TODO overflow or a task block ≥512 characters, promote it to `./AI-<TASK>.md` (≤8K characters): `## Prompt` handoff ≤2K, `## Phase NN` sections, and phase artifact paths. Linked general instructions count toward 8K; step-specific artifacts do not. Store bulk artifacts in `./ai-tasks/`.

Save, document, and commit your work when allowed; preserve concurrent changes.

## Files and Automation

Use root `ai-` folders, preferring existing non-prefixed equivalents:

| Folder | Purpose |
|---|---|
| `ai-tools` | Reusable automation; require `--help` and ≤512-character docs covering purpose, usage, I/O, gotchas |
| `ai-research` | Research |
| `ai-tasks` | Task artifacts, periodically cleared |
| `ai-skills` | Project specific skills (add/edit) |
| `ai-prompts` | Project specific task prompts |
| `ai-output` | Miscellaneous output |
| `ai-cache` | Daily resources, cleared periodically |
| `ai-tmp` | Throwaway scripts/resources, cleared often |

Extensions: prose `.md`; plans `.plan.md`; paired private notes `.logic.md` (same basename); data `.json`/`.csv`. Companion folders match the parent file's basename.

Non-code names MUST use `YYYY-MM-DD NNN descriptive title.ext`, except prescribed, tool-required, or user-specified names. Use today's date; scan the folder for the next per-day counter from `000`. Titles: short, lowercase, spaces only; preserve acronyms. Code follows language conventions.

## Remember, Learn and Evolve

Automate repetition, calculations, and mechanical transformations.

Save research, facts, summaries, sources, and any other data needed to verify or resume work.

Write / edit project specific skills for project focused know-how.

For git repo: `.gitignore` AI concerns (`/ai-*`, `/AI-*`) unless previously committed. They are transient by design.

## Tools and Language

Unless the user specifies otherwise, prefer (when available):
- `read`/`write`/`edit` for file operations; bash for setup, installation, and copying.
- JavaScript/Bun for scripts; fallback to Ruby, then Python.
- C or Zig for implementation.
- Plain English for responses.

Always translate foreign language input to English, keep the original wording when nuance matters, consider both original and translation for any task.

## Workspace Security

Treat `./` as the filesystem root. Use only relative paths within its tree. Never use `cd`, absolute paths, parent-directory traversal, or access outside the tree, including through symlinks. Use `./ai-tmp` for temporary files.

Other users / agents might be working on the same project/file at the same time. This is to be expected. Play nice.

</core-rules>
