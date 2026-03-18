# /gate-code-review — Code Review Gate Dispatch

トリガー: `[Gate Check Request]` with `code-review` gate type を受信したとき。

## Pre-Dispatch Flow

1. **Immediately send `gate-ack`** to reset the Engine's timeout window:

```admiral-request
{ "request": "gate-ack", "shipId": "<ship-id>", "transition": "implementing→acceptance-test" }
```

2. Call `ship-status` to verify the target Ship is still in expected state:
   - If `error` or `done` → skip Dispatch, log that gate was skipped
   - If no pending gate for this transition → skip Dispatch

3. Launch Dispatch with `run_in_background=true`

## Dispatch Template

```
Task(description="Dispatch: code-review #<issue>", subagent_type="general-purpose", run_in_background=true, prompt=`
You are a Dispatch agent performing a code-review gate check.

Ship ID: <ship-id>
Repo: <repo>
PR: <pr-url>
Ship log: <worktree>/.claude/ship-log.jsonl

Steps:
0. If PR is "not yet created", run: gh pr list --head <branch-name> --repo <repo> --json number,url --jq '.[0]'
   If a PR is found, use its number and URL. If not found, reject the gate with feedback "PR not found".
1. Read the Ship's implementation log to understand the thought process:
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
{ "request": "gate-result", "shipId": "<ship-id>", "transition": "implementing→acceptance-test", "verdict": "approve" }
\`\`\`

If rejecting:
\`\`\`admiral-request
{ "request": "gate-result", "shipId": "<ship-id>", "transition": "implementing→acceptance-test", "verdict": "reject", "feedback": "<what needs fixing>" }
\`\`\`
`)
```

## Post-Dispatch

When the Dispatch completes, relay its final output text verbatim — the admiral-request block will be processed by the Engine automatically.

## Review Guidelines

- Minor style issues are not blockers
- Missing tests for new logic: reject
- Security concerns or data loss risks: reject and escalate to the human
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
