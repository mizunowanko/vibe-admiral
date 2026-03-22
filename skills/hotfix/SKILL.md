---
name: hotfix
description: Engine/Ship の緊急修正。"hotfix" や "直接修正して" で起動
user-invocable: true
argument-hint: [description]
---

# /hotfix — Hotfix Dispatch (Emergency Code Fix)

Trigger: User asks Bridge to directly fix code, says "hotfix", "直接修正して", or when Ship/Engine is broken and normal sortie flow cannot proceed.

## Purpose

Emergency code modification mode where Bridge delegates a Dispatch sub-agent to make direct code changes without the full sortie workflow. Designed for situations where:
- Engine or Ship processes are broken and cannot start
- A quick 1-file fix is needed without spinning up a Ship
- Merge conflict residue or syntax errors block normal operations

## Constraints

- **No worktree**: Operates on the main branch directly in the fleet's working directory
- **No Gate checks**: Emergency mode skips plan-review and code-review gates
- **No admiral-request**: Does not use status-transition protocol (Engine may be broken)
- **Commit directly**: The Dispatch agent commits, pushes, and optionally creates a PR

## Hotfix Dispatch Template

When a user requests a hotfix, launch a Dispatch sub-agent using the Task tool:

```
Task(description="Dispatch: hotfix", subagent_type="general-purpose", prompt=`
You are a Dispatch agent performing an emergency hotfix.

Repo: <repo-path>
Issue/Problem: <description of what needs to be fixed>
Target branch: main (or current branch)

## Steps

1. **Investigate**: Read the relevant files to understand the issue
2. **Fix**: Make the minimum necessary code changes using Edit/Write tools
3. **Verify**: Run type checks and build to ensure the fix is correct
   - Frontend: npx tsc --noEmit
   - Engine: cd engine && npx tsc --noEmit
   - Build: npm run build
4. **Commit**: Stage only the changed files (never use git add -A) and commit with:
   - Prefix: fix: (for bug fixes) or refactor: (for structural fixes)
   - Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
5. **Push**: Push to the remote
6. **Report**: Summarize what was changed and why

## Rules

- Make the MINIMUM change necessary — this is an emergency fix, not a refactor
- Do NOT touch unrelated files
- Do NOT add new features
- If the fix requires more than ~3 files, recommend a proper sortie instead
- Always run verification (type check + build) before committing
`)
```

## Flow

1. User describes the problem in Bridge chat
2. Bridge identifies this as a hotfix request
3. Bridge launches Dispatch with the template above (do NOT use `run_in_background`)
4. Dispatch investigates, fixes, verifies, commits, and pushes
5. Bridge reports the result to the user

## When NOT to use Hotfix

- When the fix requires extensive changes across many files → use sortie
- When the fix needs careful planning and review → use sortie
- When you're unsure about the impact → investigate first, then decide
