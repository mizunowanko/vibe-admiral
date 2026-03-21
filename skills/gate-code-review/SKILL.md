# /gate-code-review — Code Review Gate (Escort Model)

トリガー: `[Gate Check Request]` with `code-review` gate type を受信したとき。

## Pre-Dispatch Flow

1. **Immediately send `gate-ack`** to reset the Engine's timeout window:

```admiral-request
{ "request": "gate-ack", "shipId": "<ship-id>", "gatePhase": "implementing-gate" }
```

2. Call `ship-status` to verify the target Ship is still in expected state:
   - If process is dead or phase is `done` → skip, log that gate was skipped
   - If no pending gate for this gate phase → skip

3. Check if the gate message contains `Escort agent ID: <id>`:
   - **YES**: Resume the existing Escort via `Task(resume="<id>")` (preserves plan-review context)
   - **NO**: Launch a new Escort via `Task(...)` — the Escort must register itself

## Escort Template (New — No Escort Agent ID)

```
Task(description="Escort: code-review #<issue>", subagent_type="general-purpose", run_in_background=true, prompt=`
You are an Escort agent — a persistent sub-agent dedicated to Ship #<issue>.
You will handle ALL gate checks (plan-review, code-review) for this Ship, preserving context across reviews.

Ship ID: <ship-id>
Repo: <repo>
PR: <pr-url>
Ship log: <worktree>/.claude/ship-log.jsonl

FIRST: Register yourself as this Ship's Escort by outputting:
\`\`\`admiral-request
{ "request": "escort-registered", "shipId": "<ship-id>", "agentId": "<your-agent-id>" }
\`\`\`
Note: Your agent ID will be provided by the system — use the value from your Task context.

THEN: Perform code-review:
0. If PR is "not yet created", run: gh pr list --head <branch-name> --repo <repo> --json number,url --jq '.[0]'
   If a PR is found, use its number and URL. If not found, reject the gate with feedback "PR not found".
1. Read the Ship's implementation log:
   Run: tail -n 300 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 30
2. Run: gh pr view <number> --repo <repo> --json title,body,reviews,comments
3. Check for previous review history — if there are existing "request-changes" reviews, note what was flagged
4. Run: gh pr diff <number> --repo <repo>
5. Review against: issue requirements, coding conventions, security, scope, test coverage. Use the Ship's log to understand implementation choices. If re-review, verify previous issues were addressed
6. IMPORTANT: Record your review on GitHub:
   - If approving: gh pr review <number> --repo <repo> --approve --body "<review summary>"
   - If rejecting: gh pr review <number> --repo <repo> --request-changes --body "<detailed feedback>"
7. Output EXACTLY one admiral-request block as your FINAL output:

If approving:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "gatePhase": "implementing-gate", "verdict": "approve" }
\`\`\`

If rejecting:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "gatePhase": "implementing-gate", "verdict": "reject", "feedback": "<what needs fixing>" }
\`\`\`
`)
```

## Escort Template (Resume — Escort Agent ID Present)

```
Task(description="Escort: code-review #<issue>", resume="<escort-agent-id>", run_in_background=true, prompt=`
You are resuming as the Escort for Ship #<issue>. You have context from previous gate checks (e.g., plan-review).
Use your prior knowledge of the plan to evaluate whether the implementation matches what was approved.

NEW TASK: code-review gate check.
Ship ID: <ship-id>
Repo: <repo>
PR: <pr-url>
Ship log: <worktree>/.claude/ship-log.jsonl

Perform code-review:
0. If PR is "not yet created", run: gh pr list --head <branch-name> --repo <repo> --json number,url --jq '.[0]'
   If a PR is found, use its number and URL. If not found, reject the gate with feedback "PR not found".
1. Read the Ship's implementation log:
   Run: tail -n 300 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 30
2. Run: gh pr view <number> --repo <repo> --json title,body,reviews,comments
3. Check for previous review history
4. Run: gh pr diff <number> --repo <repo>
5. Review against: issue requirements, coding conventions, security, scope, test coverage. Compare against the plan you reviewed earlier (if applicable). If re-review, verify previous issues were addressed
6. Record review on GitHub:
   - If approving: gh pr review <number> --repo <repo> --approve --body "<review summary>"
   - If rejecting: gh pr review <number> --repo <repo> --request-changes --body "<detailed feedback>"
7. Output EXACTLY one admiral-request block:

If approving:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "gatePhase": "implementing-gate", "verdict": "approve" }
\`\`\`

If rejecting:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "gatePhase": "implementing-gate", "verdict": "reject", "feedback": "<what needs fixing>" }
\`\`\`
`)
```

## Post-Dispatch

When the Escort completes, relay its final output text verbatim — the admiral-request block will be processed by the Engine automatically.

## Review Guidelines

- Minor style issues are not blockers
- Missing tests for new logic: reject
- Security concerns or data loss risks: reject and escalate to the human
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- When resuming: leverage plan-review context to check implementation matches the approved plan
