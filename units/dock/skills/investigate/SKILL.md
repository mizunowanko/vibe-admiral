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

**Bridge must NEVER read source code directly.** Always delegate to a Dispatch process via `POST /api/dispatch`.

## Bug Investigation Template

Launch via Engine API (`POST /api/dispatch`):

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "flagship",
    "name": "investigate-bug",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent investigating a bug.\n\nRepo: <repo>\nBug description: <description from user or Ship error>\n\nSteps:\n1. Explore the codebase to identify the root cause\n2. Identify affected files and the scope of the issue\n3. Determine reproduction steps if possible\n4. Analyze potential fixes and their impact\n\nOutput a clear summary:\n- **Root cause**: ...\n- **Affected files**: ...\n- **Reproduction**: ...\n- **Suggested fix**: ...\n- **Impact scope**: ...\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

## Codebase Exploration Template

Launch via Engine API (`POST /api/dispatch`):

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "flagship",
    "name": "explore-codebase",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent exploring the codebase.\n\nRepo: <repo>\nQuestion: <what needs to be understood>\n\nSteps:\n1. Search the codebase for relevant files and code\n2. Read and analyze the relevant sections\n3. Map out the architecture/relationships relevant to the question\n\nOutput a clear summary. Do NOT create issues or make any changes."
  }'
```

## Ship Error Diagnosis Template

> **調査順序を厳守**: ソースコードを先に読んではいけない。ログなしの仮説は精度が低い。ログを見れば「実際に何が起きたか」がわかり、仮説の質が格段に上がる。ソースコードは仮説の**検証**に使うもので、仮説の**生成**に使うものではない。

Launch via Engine API (`POST /api/dispatch`):

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "flagship",
    "name": "diagnose-ship-error",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent diagnosing a Ship error.\n\nRepo: <repo>\nShip issue: #<issue-number>\nError context: <error details from Ship status>\nShip log: <worktree>/.claude/ship-log.jsonl\n\nIMPORTANT: Follow the investigation order strictly. Do NOT read source code until steps 1-4 are complete.\n\nSteps (in strict order):\n1. **[MUST] Engine ログ** — Engine の stdout/stderr を確認。クラッシュ、未捕捉例外、WS エラー等:\n   Run: tail -n 200 <engine-log-path> 2>/dev/null | grep -iE \"error|exception|crash|ECONNREFUSED|SIGTERM\" | tail -n 20\n2. **[MUST] Ship chat log** — Ship が何をしていたか、どこで止まったか:\n   Run: tail -n 300 <worktree>/.claude/ship-log.jsonl | grep \"\\\"type\\\":\\\"assistant\\\"\" | tail -n 30\n   Run: tail -n 100 <worktree>/.claude/ship-log.jsonl | grep -i \"\\\"type\\\":\\\"result\\\"\"\n3. **[MUST] Escort chat log** — Gate の判定内容、reject 理由等:\n   Run: tail -n 200 <worktree>/.claude/escort-log.jsonl 2>/dev/null | grep \"\\\"type\\\":\\\"assistant\\\"\" | tail -n 20\n4. **DB の状態** — phase_transitions テーブルで遷移履歴を確認\n5. **ソースコード** — 上記 1〜4 で得た情報をもとに、初めてソースコードを読む\n\nOUTPUT FORMAT CONSTRAINT — keep your response concise (max 12 lines):\n- **Error**: <1 sentence>\n- **Root cause**: <1 sentence>\n- **Last Ship actions**: <1-2 sentences summarizing key actions from log>\n- **Recovery recommendation**: Choose one of:\n  - **ship-resume** (preferred): Use when error is transient (rate limit, etc.), preserves session/PR\n  - **ship-resume (re-sortie)**: Use when session is unavailable but branch/PR should be preserved\n  - **manual intervention**: Use when error is fundamental (wrong approach, impossible task)\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

## Ship Log Reading

Ship logs are stored at `<worktree>/.claude/ship-log.jsonl`, Escort logs at `<worktree>/.claude/escort-log.jsonl`. Read them via Dispatch using these patterns:

- **Ship recent assistant messages**: `tail -n 300 <worktree>/.claude/ship-log.jsonl | grep '"type":"assistant"' | tail -n 30`
- **Ship final result**: `tail -n 100 <worktree>/.claude/ship-log.jsonl | grep '"type":"result"'`
- **Escort recent messages**: `tail -n 200 <worktree>/.claude/escort-log.jsonl | grep '"type":"assistant"' | tail -n 20`

Always read logs via Dispatch — Commanders must not read files directly.

## Ship Error Recovery Flow

When a Ship's process dies (processDead), Bridge receives a system message with resume eligibility:
1. Receive Ship error notification (Ship ID + resume info)
2. Launch a Dispatch (using diagnosis template above)
3. Based on diagnosis, use `ship-resume` (Request #7) if recoverable.

## Investigation Flow

1. Identify that investigation is needed
2. **以下の順序を厳守して Dispatch** — Ship Error Diagnosis テンプレートを使用:
   1. **Engine ログ** — Engine の stdout/stderr（クラッシュ、未捕捉例外、WS エラー等）
   2. **Ship chat log** — `.claude/ship-log.jsonl`（Ship が何をしていたか、どこで止まったか）
   3. **Escort chat log** — `.claude/escort-log.jsonl`（Gate の判定内容、reject 理由等）
   4. **DB の状態** — phase_transitions テーブルで遷移履歴を確認
   5. **ソースコード** — 上記 1〜4 で得た情報をもとに、初めてソースコードを読む
3. Launch additional Dispatch processes with appropriate templates if needed (`POST /api/dispatch`)
4. Continue normal duties while Dispatch runs
5. When Dispatch completes, review findings
6. Take action: create issues (`gh issue create`), report to user, or plan next steps
7. **Bridge always makes final decisions and creates issues** — Dispatch only provides information

> **ソースコードを先に読んではいけない**: ログなしの仮説は「こうなりそう」という推測にすぎず、精度が低い。ログを見れば「実際に何が起きたか」がわかる。ソースコードは仮説の**検証**に使うもので、仮説の**生成**に使うものではない。
