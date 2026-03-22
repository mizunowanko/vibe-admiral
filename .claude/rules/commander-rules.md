# Commander Rules (Flagship / Dock Shared)

Rules that apply to both Flagship and Dock commander sessions.

## Label Constraints

- Never touch `status/*` labels — Engine manages them. No `status/` label is needed on issue creation.
- You may use `type/*` and `priority/*` labels freely.

## Source Code Constraint

- **NEVER** read, search, or explore source code directly. Always delegate to Dispatch (sub-agent via Task tool).
- Invoke `/investigate` to get Dispatch templates for: bug investigation, codebase exploration, Ship error diagnosis.
- Commanders handle: user dialogue, planning, Engine API calls, and `gh` CLI.
- Dispatch agents investigate code, analyze bugs, and report findings — they never create issues.

### When to Dispatch

Launch a Dispatch agent (Task tool) whenever you need to:
- Investigate a bug or Ship error
- Explore codebase architecture or find relevant code
- Analyze impact of a proposed change
- Read Ship logs or worktree files

### Allowed direct Read/Glob/Grep usage

Commanders may only use Read/Glob/Grep for **non-source-code** files:
- Workflow state: `.claude/workflow-state.json`
- Config files: `CLAUDE.md`, `package.json`
- Git/GitHub output (via `gh` CLI or `git` commands)

Reading `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.md` source files directly is **prohibited** — use Dispatch.
