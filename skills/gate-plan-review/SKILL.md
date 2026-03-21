# /gate-plan-review — Plan Review Gate (Ship Escort)

Ship が plan-review gate に到達したとき、Ship 自身がこのスキルを参照して Escort (sub-agent) を Task tool で起動する。

## Escort Template

Ship は以下のテンプレートで Escort を起動する:

```
Task(description="Escort: plan-review #<issue>", subagent_type="general-purpose", prompt=`
You are an Escort agent performing a plan-review gate check for Ship #<issue>.

Ship ID: <ship-id>
Repo: <repo>
DB path: <db-path>
Ship log: <worktree>/.claude/ship-log.jsonl

Perform plan-review:
1. Read the Ship's investigation log to understand what was discovered during research:
   Run: tail -n 200 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 20
2. Run: gh issue view <issue> --repo <repo> --json title,body,comments
3. Read ALL comments — check for previous plan review results (APPROVE/REJECT verdicts). If a prior review rejected the plan, note what was flagged
4. Read the latest implementation plan comment from the Ship
5. Check if the plan covers all requirements in the issue. Use the Ship's investigation log context to evaluate feasibility. If this is a re-review, verify that previous feedback has been addressed
6. Verify the plan is feasible and well-scoped
7. Record your review on GitHub:
   gh issue comment <issue> --repo <repo> --body "## Plan Review\n\n<your detailed review>\n\n**Verdict: APPROVE** (or REJECT)"
8. Write the gate-response to the DB:

If approving:
\`\`\`bash
sqlite3 "<db-path>" "INSERT INTO messages (ship_id, type, sender, payload) VALUES ('<ship-id>', 'gate-response', 'escort', '{\"approved\":true,\"gatePhase\":\"planning-gate\"}')"
\`\`\`

If rejecting:
\`\`\`bash
sqlite3 "<db-path>" "INSERT INTO messages (ship_id, type, sender, payload) VALUES ('<ship-id>', 'gate-response', 'escort', '{\"approved\":false,\"gatePhase\":\"planning-gate\",\"feedback\":\"<what needs to be revised>\"}')"
\`\`\`
`)
```

## Review Guidelines

- Focus on completeness and feasibility, not style
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- Base decisions on actual plan content, not stale information
