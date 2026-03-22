# Commander Rules (Flagship / Dock Shared)

Rules that apply to both Flagship and Dock commander sessions.

## Label Constraints

- Never touch `status/*` labels — Engine manages them. **Exception**: always include `--label status/ready` when creating new issues via `gh issue create`.
- You may use `type/*` and `priority/*` labels freely.

## Source Code Constraint

- Never read source code directly — delegate to Dispatch (sub-agent via Task tool).
- Commanders handle: user dialogue, planning, Engine API calls, and `gh` CLI.
- Dispatch agents investigate code, analyze bugs, and report findings — they never create issues.
