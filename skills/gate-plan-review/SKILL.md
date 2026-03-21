# /gate-plan-review — Plan Review Gate (Escort Model)

トリガー: `[Gate Check Request]` with `plan-review` gate type を受信したとき。

## Pre-Dispatch Flow

1. **Immediately send `gate-ack`** to reset the Engine's timeout window:

```admiral-request
{ "request": "gate-ack", "shipId": "<ship-id>", "transition": "planning→implementing" }
```

2. Call `ship-status` to verify the target Ship is still in expected state:
   - If `error` or `done` → skip, log that gate was skipped
   - If no pending gate for this transition → skip

3. Check if the gate message contains `Escort agent ID: <id>`:
   - **YES**: Resume the existing Escort via `Task(resume="<id>")` (preserves prior review context)
   - **NO**: Launch a new Escort via `Task(...)` — the Escort must register itself

## Escort Template (New — No Escort Agent ID)

```
Task(description="Escort: plan-review #<issue>", subagent_type="general-purpose", run_in_background=true, prompt=`
You are an Escort agent — a persistent sub-agent dedicated to Ship #<issue>.
You will handle ALL gate checks (plan-review, code-review) for this Ship, preserving context across reviews.

Ship ID: <ship-id>
Repo: <repo>
Ship log: <worktree>/.claude/ship-log.jsonl

FIRST: Register yourself as this Ship's Escort by outputting:
\`\`\`admiral-request
{ "request": "escort-registered", "shipId": "<ship-id>", "agentId": "<your-agent-id>" }
\`\`\`
Note: Your agent ID will be provided by the system — use the value from your Task context.

THEN: Perform plan-review:
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

## Escort Template (Resume — Escort Agent ID Present)

```
Task(description="Escort: plan-review #<issue>", resume="<escort-agent-id>", run_in_background=true, prompt=`
You are resuming as the Escort for Ship #<issue>. You have context from previous interactions.

NEW TASK: plan-review gate check.
Ship ID: <ship-id>
Repo: <repo>
Ship log: <worktree>/.claude/ship-log.jsonl

Perform plan-review:
1. Read the Ship's investigation log:
   Run: tail -n 200 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 20
2. Run: gh issue view <issue> --repo <repo> --json title,body,comments
3. Read ALL comments — check for previous reviews. If a prior review rejected, note what was flagged
4. Read the latest implementation plan comment
5. Evaluate completeness, feasibility, and scope
6. Record review on GitHub:
   gh issue comment <issue> --repo <repo> --body "## Plan Review\n\n<your detailed review>\n\n**Verdict: APPROVE** (or REJECT)"
7. Output EXACTLY one admiral-request block:

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

When the Escort completes, relay its final output text verbatim — the admiral-request block will be processed by the Engine automatically.

## Review Guidelines

- Focus on completeness and feasibility, not style
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- Base decisions on actual plan content, not stale information
