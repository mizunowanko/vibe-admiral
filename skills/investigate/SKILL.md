---
name: investigate
description: バグ調査・Ship エラー分析・コードベース調査。Dispatch テンプレートとして使用
user-invocable: true
argument-hint: [description or issue-number]
---

# /investigate — Investigation Dispatch Templates

トリガー: バグ報告、Ship エラー、コードベースの質問があったとき。

## When to Dispatch

- Bug investigation (root cause, affected files, reproduction steps)
- Codebase exploration (architecture, relevant code, impact analysis)
- Ship error diagnosis (analyzing failure, recovery recommendation)
- Any task requiring reading source files or running analysis commands

**Bridge must NEVER read source code directly.** Always delegate to a Dispatch agent.

## Bug Investigation Template

```
Task(description="Dispatch: investigate bug", subagent_type="general-purpose", run_in_background=true, prompt=`
You are a Dispatch agent investigating a bug.

Repo: <repo>
Bug description: <description from user or Ship error>

Steps:
1. Explore the codebase to identify the root cause
2. Identify affected files and the scope of the issue
3. Determine reproduction steps if possible
4. Analyze potential fixes and their impact

Output a clear summary:
- **Root cause**: ...
- **Affected files**: ...
- **Reproduction**: ...
- **Suggested fix**: ...
- **Impact scope**: ...

Do NOT create issues or make any changes. Only investigate and report.
`)
```

## Codebase Exploration Template

```
Task(description="Dispatch: explore codebase", subagent_type="general-purpose", run_in_background=true, prompt=`
You are a Dispatch agent exploring the codebase.

Repo: <repo>
Question: <what needs to be understood>

Steps:
1. Search the codebase for relevant files and code
2. Read and analyze the relevant sections
3. Map out the architecture/relationships relevant to the question

Output a clear summary. Do NOT create issues or make any changes.
`)
```

## Ship Error Diagnosis Template

> **ログ確認が最優先**: DB の phase 遷移やフロントエンド通知は補助情報。実際に何が起きているかはログにしかない。推測で行動する前に必ずログを読むこと。

```
Task(description="Dispatch: diagnose Ship error", subagent_type="general-purpose", run_in_background=true, prompt=`
You are a Dispatch agent diagnosing a Ship error.

Repo: <repo>
Ship issue: #<issue-number>
Error context: <error details from Ship status>
Ship log: <worktree>/.claude/ship-log.jsonl

IMPORTANT: Always read logs FIRST before any other investigation.
DB phase history and frontend notifications are supplementary — the log is the source of truth.

Steps:
1. **[MUST] Read the Ship's CLI log first** — this is the highest priority:
   Run: tail -n 300 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 30
2. Check for error messages in the log:
   Run: tail -n 100 <worktree>/.claude/ship-log.jsonl | grep -i '"type":"result"'
3. If Escort is involved, read Escort logs as well:
   Run: find <worktree>/.. -name 'ship-log.jsonl' -path '*escort*' 2>/dev/null
4. Read work context (PR diff, commits) if available
5. Identify what went wrong and why

OUTPUT FORMAT CONSTRAINT — keep your response concise (max 12 lines):
- **Error**: <1 sentence>
- **Root cause**: <1 sentence>
- **Last Ship actions**: <1-2 sentences summarizing key actions from log>
- **Recovery recommendation**: Choose one of:
  - **ship-resume** (preferred): Use when error is transient (rate limit, etc.), preserves session/PR
  - **ship-resume (re-sortie)**: Use when session is unavailable but branch/PR should be preserved
  - **manual intervention**: Use when error is fundamental (wrong approach, impossible task)

Do NOT create issues or make any changes. Only investigate and report.
`)
```

## Ship Log Reading

Ship logs are stored at `<worktree>/.claude/ship-log.jsonl`. Read them via Dispatch using these patterns:

- **Recent assistant messages**: `tail -n 300 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 30`
- **Final result**: `tail -n 100 <worktree>/.claude/ship-log.jsonl | grep '"type":"result"'`

Always read logs via Dispatch — Commanders must not read files directly.

## Ship Error Recovery Flow

When a Ship's process dies (processDead), Bridge receives a system message with resume eligibility:
1. Receive Ship error notification (Ship ID + resume info)
2. Launch a Dispatch (using diagnosis template above)
3. Based on diagnosis, use `ship-resume` (Request #7) if recoverable.

## Investigation Flow

1. Identify that investigation is needed
2. **Read Ship/Escort logs first** — launch Dispatch with the Ship Error Diagnosis template to read logs before any other action
3. Launch additional Dispatch agents with appropriate templates if needed (`run_in_background=true`)
4. Continue normal duties while Dispatch runs
5. When Dispatch completes, review findings
6. Take action: create issues (`gh issue create`), report to user, or plan next steps
7. **Bridge always makes final decisions and creates issues** — Dispatch only provides information

> **ログ最優先**: Ship 異常の調査では、DB phase 遷移やフロントエンド通知だけで判断せず、必ずログを最初に確認すること。
