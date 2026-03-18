# /gate-plan-review — Plan Review Gate Dispatch

トリガー: `[Gate Check Request]` with `plan-review` gate type を受信したとき。

## Pre-Dispatch Flow

1. **Immediately send `gate-ack`** to reset the Engine's timeout window:

```admiral-request
{ "request": "gate-ack", "shipId": "<ship-id>", "transition": "planning→implementing" }
```

2. Call `ship-status` to verify the target Ship is still in expected state:
   - If `error` or `done` → skip Dispatch, log that gate was skipped
   - If no pending gate for this transition → skip Dispatch

3. Launch Dispatch with `run_in_background=true`

## Dispatch Template

```
Task(description="Dispatch: plan-review #<issue>", subagent_type="general-purpose", run_in_background=true, prompt=`
You are a Dispatch agent performing a plan-review gate check for Ship #<issue>.

Ship ID: <ship-id>
Repo: <repo>
Ship log: <worktree>/.claude/ship-log.jsonl

Steps:
1. Read the Ship's investigation log to understand what was discovered during research:
   Run: tail -n 200 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 20
2. Run: gh issue view <issue> --repo <repo> --json title,body,comments
3. Read ALL comments — check for previous plan review results (APPROVE/REJECT verdicts). If a prior review rejected the plan, note what was flagged
4. Read the latest implementation plan comment from the Ship
5. Check if the plan covers all requirements in the issue. Use the Ship's investigation log context to evaluate feasibility. If this is a re-review, verify that previous feedback has been addressed
6. Verify the plan is feasible and well-scoped
7. IMPORTANT: Record your review on GitHub:
   gh issue comment <issue> --repo <repo> --body "## Plan Review\n\n<your detailed review>\n\n**Verdict: APPROVE** (or REJECT)"
8. Output EXACTLY one admiral-request block as your FINAL output:

If approving:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "transition": "planning→implementing", "verdict": "approve" }
\`\`\`

If rejecting:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "transition": "planning→implementing", "verdict": "reject", "feedback": "<what needs to be revised>" }
\`\`\`
`)
```

## Post-Dispatch

When the Dispatch completes, relay its final output text verbatim — the admiral-request block will be processed by the Engine automatically.

## Review Guidelines

- Focus on completeness and feasibility, not style
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- Base decisions on actual plan content, not stale information
