---
name: hotfix
description: Engine/Ship の緊急修正。"hotfix" や "直接修正して" で起動
user-invocable: true
argument-hint: [description]
---

# /hotfix — Hotfix Dispatch (Emergency Code Fix)

Trigger: User asks Bridge to directly fix code, says "hotfix", "直接修正して", or when Ship/Engine is broken and normal sortie flow cannot proceed.

## Purpose

Emergency code modification mode where Bridge launches a Dispatch process via Engine API to make direct code changes without the full sortie workflow. Designed for situations where:
- Engine or Ship processes are broken and cannot start
- A quick 1-file fix is needed without spinning up a Ship
- Merge conflict residue or syntax errors block normal operations

## Constraints

- **No worktree**: Operates in the fleet's working directory (creates a hotfix branch from main)
- **No Gate checks**: Emergency mode skips plan-review and code-review gates
- **No admiral-request**: Does not use status-transition protocol (Engine may be broken)
- **PR required**: The Dispatch agent creates a hotfix branch, commits, pushes, creates a PR, and self-merges

## Hotfix Dispatch Template

When a user requests a hotfix, launch a Dispatch process via Engine API (`POST /api/dispatch`):

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "flagship",
    "name": "hotfix",
    "type": "modify",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent performing an emergency hotfix.\n\nRepo: <repo-path>\nIssue/Problem: <description of what needs to be fixed>\nIssue number: <issue-num>\n\n## Steps\n\n1. **Branch**: Create a hotfix branch from main:\n   - git checkout main && git pull origin main\n   - git checkout -b hotfix/<short-description>\n2. **Investigate**: Read the relevant files to understand the issue\n3. **Fix**: Make the minimum necessary code changes using Edit/Write tools\n4. **Verify**: Run type checks and build to ensure the fix is correct\n   - Frontend: npx tsc --noEmit\n   - Engine: cd engine && npx tsc --noEmit\n   - Build: npm run build\n5. **Commit**: Stage only the changed files (never use git add -A) and commit with:\n   - Prefix: fix: (for bug fixes) or refactor: (for structural fixes)\n   - Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>\n6. **Push**: Push the hotfix branch to the remote:\n   - git push -u origin hotfix/<short-description>\n7. **PR**: Create a pull request:\n   - gh pr create --title 'fix: <summary>' --body 'Closes #<issue-num>\\n\\n<description of what was changed and why>'\n8. **Merge**: Self-merge the PR:\n   - gh pr merge --merge\n9. **Report**: Summarize what was changed and why, include the PR URL\n\n## Rules\n\n- Make the MINIMUM change necessary — this is an emergency fix, not a refactor\n- Do NOT touch unrelated files\n- Do NOT add new features\n- If the fix requires more than ~3 files, recommend a proper sortie instead\n- Always run verification (type check + build) before committing\n- Always create a PR — never push directly to main"
  }'
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
