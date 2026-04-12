---
name: audit-bug
description: Ship チャットログ・ソースコード・E2E テストを並行分析し、未発見バグを検出して issue を起票する
user-invocable: true
argument-hint: []
---

# /audit-bug — 未発見バグの検出 & Issue 起票

Ship チャットログ、ソースコード、E2E テスト実行を 3 つの Dispatch で**並行**分析し、未発見のバグを検出して issue を起票する。

## 前提

- Commander（Dock）から呼び出される
- ソースコードの調査は全て Dispatch 経由（Commander はコードを直接読まない）
- Issue 起票は Commander が `gh issue create` で行う（Dispatch は起票しない）

## Step 1: 3 Dispatch を並行起動

3 つの Dispatch を順次発行し、全完了を待つ。

### 1a. チャットログ分析（Dispatch Y）

Ship の ship-log.jsonl / escort-log.jsonl を読み、潜在バグのパターンを検出する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "audit-bug-chatlog",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent analyzing Ship chat logs for potential bugs.\n\nRepo: <repo-path>\n\n## Task\n\nAnalyze Ship and Escort chat logs to find evidence of bugs.\n\n### Steps\n\n1. Find all worktree directories:\n   ls -d ../.worktrees/feature/*/ 2>/dev/null || ls -d .worktrees/feature/*/ 2>/dev/null\n2. Randomly select 3-5 worktrees that have log files\n3. For each selected worktree, read:\n   - `.claude/ship-log.jsonl` — Ship activity log\n   - `.claude/escort-log.jsonl` — Escort gate review log\n4. Analyze for these bug indicators:\n   - **Error messages**: unhandled exceptions, stack traces, unexpected errors\n   - **Abnormal transitions**: phase transitions that skip steps or go backwards unexpectedly\n   - **Retry loops**: the same operation retried more than 3 times\n   - **Unhandled exceptions**: errors that were not caught or recovered from\n   - **Escort reject patterns**: repeated rejections for the same reason (indicates a systemic issue)\n   - **Process crashes**: processDead events, unexpected exits\n   - **Timeout patterns**: operations that consistently hit timeouts\n\n### Output format\n\n```\n## Chat Log Analysis Results\n\n### Analyzed Ships\n| Ship (worktree) | Issue # | Logs Found |\n|-----------------|---------|------------|\n\n### Potential Bugs Found\n\n#### Bug Y-1: <title>\n- **Source**: <worktree> / <log file>\n- **Evidence**: <relevant log excerpt (max 5 lines)>\n- **Category**: ERROR | ABNORMAL_TRANSITION | RETRY_LOOP | UNHANDLED_EXCEPTION | ESCORT_PATTERN | CRASH | TIMEOUT\n- **Severity**: critical | high | medium | low\n- **Description**: <what the bug appears to be>\n- **Suspected Root Cause**: <hypothesis based on log evidence>\n\n### Escort Reject Patterns\n| Reject Reason | Frequency | Affected Ships |\n|---------------|-----------|----------------|\n```\n\nDo NOT create issues or make changes. Only investigate and report."
  }'
```

### 1b. ソースコード分析（Dispatch Z）

Engine のコード品質問題を検出する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "audit-bug-sourcecode",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent performing static analysis on the Engine source code to find potential bugs.\n\nRepo: <repo-path>\n\n## Task\n\nAnalyze the Engine source code for potential bugs in these categories:\n\n### 1. Error Handling Gaps\n- Find async functions without try-catch\n- Find Promise chains without .catch()\n- Find event handlers without error handling\n- Check: grep -rn \"async \" engine/src/ and verify each has proper error handling\n\n### 2. Type Safety Issues\n- Find `as any` type assertions: grep -rn \"as any\" engine/src/\n- Find `as unknown` followed by another assertion\n- Find non-null assertions `!.` in risky contexts\n- Find `@ts-ignore` or `@ts-expect-error` comments\n\n### 3. Race Conditions\n- Find shared mutable state accessed from async contexts\n- Find operations that depend on ordering of async events without locks/guards\n- Check process lifecycle management for cleanup/launch race conditions\n- Look for patterns like: read state → await → use state (state may have changed)\n\n### 4. Dead Code & Unreachable Paths\n- Find exported functions that are never imported elsewhere\n- Find switch/case branches that can never be reached\n- Find conditional branches with conditions that are always true/false\n\n### Output format\n\n```\n## Source Code Analysis Results\n\n### Error Handling Gaps\n\n#### Bug Z-1: <title>\n- **File**: <path>:<line>\n- **Code**: <relevant code snippet (max 5 lines)>\n- **Issue**: <description of the gap>\n- **Severity**: critical | high | medium | low\n- **Suggested Fix**: <brief fix description>\n\n### Type Safety Issues\n(same format)\n\n### Race Conditions\n(same format)\n\n### Dead Code\n(same format)\n\n## Summary\n| Category | Count | Critical | High | Medium | Low |\n|----------|-------|----------|------|--------|-----|\n```\n\nDo NOT create issues or make changes. Only investigate and report."
  }'
```

### 1c. E2E テストカバレッジ分析・増強・実行（Dispatch W）

E2E テストのカバレッジを分析してテストを増強し、既存＋増強分のテストを実行して失敗からバグを検出する。

以下 3 サブステップ（W-1 → W-2 → W-3）を 1 つの Dispatch 内で順次実行する。

**W-1: テストカバレッジ分析**
- `e2e/*.spec.ts` の一覧を確認し、各テストが検証しているフロー・機能を把握
- 現在の機能一覧（Ship ライフサイクル、Fleet 切り替え、Commander 操作、Dispatch 起動等）と突合
- テストされていない機能・フローを特定

**W-2: テスト増強**
- カバレッジ不足箇所にテストを追加
- 過去バグの再発防止テスト（regression test）を重点的に追加
  - closed な `type/bug` issue を参照し、再発防止観点でテストを書き起こす
- 未カバー機能フロー（Fleet CRUD、Ship sortie/stop/resume、Commander chat、Dispatch 起動等）を優先
- 追加したテストをコミットする（`test: add regression/coverage tests for audit-bug` 等）

**W-3: テスト実行**
- `npx playwright test --config playwright.e2e.config.ts` で既存 + 増強分を実行
- 失敗テストを BUG / TEST_ISSUE / FLAKY に分類
- BUG カテゴリは根本原因をアプリケーションコードから追跡

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "audit-bug-e2e",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent auditing E2E test coverage, enhancing tests, and running them to discover bugs.\n\nRepo: <repo-path>\n\n## Task\n\nExecute three sequential sub-steps (W-1 \u2192 W-2 \u2192 W-3). Do NOT skip W-1/W-2 even if tests appear comprehensive.\n\n### W-1: Test Coverage Analysis\n\n1. List all existing E2E test files:\n   ls e2e/*.spec.ts 2>/dev/null || find . -name \"*.spec.ts\" -path \"*/e2e/*\"\n2. For each test file, read it and summarize what flow/feature it validates\n3. Cross-reference with the current feature set:\n   - Ship lifecycle (sortie / stop / resume / abandon / retry)\n   - Fleet CRUD (create / switch / delete / settings)\n   - Commander operations (Flagship / Dock chat, Dispatch launch)\n   - Gate flow (planning-gate / implementing-gate / acceptance-test-gate)\n   - Phase transitions and UI updates\n4. Identify untested features/flows and output a coverage-gap table\n\n### W-2: Test Enhancement\n\n1. For identified coverage gaps, prioritize:\n   - **Regression tests for past bugs** \u2014 query recent closed `type/bug` issues:\n     gh issue list --state closed --label type/bug --limit 20 --json number,title,body\n     For each past bug, assess whether an E2E regression test exists. If not, add one.\n   - **Uncovered critical feature flows** \u2014 Fleet CRUD, Ship sortie/stop/resume, Commander chat, Dispatch launch\n2. Write new tests under `e2e/`, following existing test conventions\n3. Commit the added tests:\n   git add e2e/<new-test-files>\n   git commit -m \"test: add regression/coverage tests for audit-bug\"\n4. Only add tests that are actually executable and meaningful. Do NOT fabricate tests for features that do not exist.\n\n### W-3: Test Execution\n\n1. Check for playwright config:\n   ls playwright*.config.* 2>/dev/null\n2. Run all E2E tests (existing + newly added):\n   npx playwright test --config playwright.e2e.config.ts 2>&1\n3. If tests fail, run each failed test individually for detailed output:\n   npx playwright test --config playwright.e2e.config.ts <test-file> 2>&1\n4. Categorize each failure:\n   - **BUG**: Application code is broken (the test correctly catches a real bug)\n   - **TEST_ISSUE**: Test itself is broken (selector changed, timing issue, bad assertion)\n   - **FLAKY**: Intermittent failure (timing-dependent, environment-dependent)\n5. For BUG category failures, trace the root cause in the application code\n\n### Output format\n\n```\n## E2E Audit Results\n\n### W-1: Coverage Analysis\n\n#### Existing Tests\n| Test File | Covered Flow/Feature |\n|-----------|----------------------|\n\n#### Coverage Gaps\n| Untested Area | Risk Level | Description |\n|---------------|-----------|-------------|\n\n### W-2: Test Enhancement\n\n#### Added Tests\n| Test File | Target | Type (regression / coverage) | Related Past Bug |\n|-----------|--------|------------------------------|-------------------|\n\n#### Commit\n- Commit SHA: <sha>\n- Message: <commit message>\n\n### W-3: Execution Summary\n- **Total**: N tests\n- **Passed**: N\n- **Failed**: N\n- **Skipped**: N\n\n#### Failures\n\n##### Bug W-1: <title>\n- **Test**: `e2e/<file>.spec.ts` \u2014 \"<test name>\"\n- **Category**: BUG | TEST_ISSUE | FLAKY\n- **Error**: <error message>\n- **Stack**: <first 5 lines of stack trace>\n- **Root Cause**: <analysis of why this fails>\n- **Severity**: critical | high | medium | low\n\n## Summary\n| Category | Count |\n|----------|-------|\n| Coverage Gaps (W-1) | N |\n| Added Tests (W-2) | N |\n| BUG | N |\n| TEST_ISSUE | N |\n| FLAKY | N |\n```\n\nYou MAY write and commit new test files under `e2e/` for W-2. Do NOT modify application source code and do NOT create issues. Only audit, enhance tests, run tests, and report."
  }'
```

### Dispatch 完了待ち

全 Dispatch の完了を確認する:

```bash
curl -s "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatches?fleetId=<fleet-id>" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
dispatches = data.get('dispatches', [])
names = ['audit-bug-chatlog', 'audit-bug-sourcecode', 'audit-bug-e2e']
for name in names:
    matches = [d for d in dispatches if d['name'] == name]
    if matches:
        d = matches[-1]
        print(f\"{name}: {d['status']}\")
        if d['status'] == 'completed' and d.get('result'):
            print(d['result'][:500])
            print('...(truncated)')
    else:
        print(f'{name}: NOT_FOUND')
    print('---')
"
```

未完了の Dispatch がある場合は 30 秒待って再確認する。全 Dispatch が `completed` になるまで繰り返す。

## Step 2: 結果の統合・分析

3 Dispatch の結果を取得して統合分析する。

### 2a. 結果の取得

各 Dispatch の結果を取得する:

```bash
curl -s "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatches?fleetId=<fleet-id>" | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
dispatches = data.get('dispatches', [])
for name in ['audit-bug-chatlog', 'audit-bug-sourcecode', 'audit-bug-e2e']:
    matches = [d for d in dispatches if d['name'] == name and d['status'] == 'completed']
    if matches:
        print(f'=== {name} ===')
        print(matches[-1].get('result', 'NO_RESULT'))
        print()
"
```

### 2b. 統合・重複排除

以下の観点で 3 つの結果を統合する:

1. **バグの統合**: 同じ根本原因を持つ発見は 1 つにまとめる（例: ログで観測されたエラーとコードで見つかった error handling 漏れが同一箇所）
2. **重複排除**: 既存 issue との照合
3. **優先度付け**: severity × evidence strength でランキング

### 2c. 既存 issue との照合

```bash
# Open issues
gh issue list --state open --label "type/bug" --limit 50 --json number,title,body

# Recently closed issues (重複チェック)
gh issue list --state closed --label "type/bug" --limit 30 --json number,title,body
```

各発見について、既存 issue のタイトル・本文と照合し、重複がある場合はスキップする。

## Step 3: Issue 起票

重複でないバグごとに `type/bug` ラベル付き issue を起票する。

**Issue フォーマット**:

```bash
gh issue create \
  --title "bug: <バグの簡潔な説明>" \
  --label "type/bug" \
  --body "$(cat <<'ISSUEEOF'
## 概要

<バグの説明（1-2 文）>

## 発見元

- **検出方法**: <chatlog-analysis | source-code-analysis | e2e-test>
- **証拠**:
  - <ログの該当箇所、コードの行番号、テストのエラーメッセージ等>

## 再現手順

1. <手順 1>
2. <手順 2>
3. <手順 3>

（ソースコード分析で発見された場合は「コードパス」として記述）

## 期待動作

<正しい動作>

## 実際の動作

<観測された or 推定される不正な動作>

## 影響範囲

- **Severity**: <critical | high | medium | low>
- **影響する Unit**: <Ship | Escort | Commander | Engine | Frontend>
- **頻度**: <常時 | 条件付き | 稀>

## 関連

- #913 — audit-bug スキルによる検出
ISSUEEOF
)"
```

### 起票ルール

- severity が `low` のものは起票せず、サマリにのみ記載する
- TEST_ISSUE / FLAKY カテゴリは `type/test` ラベルで起票する（`type/bug` ではない）
- 1 回の audit で起票する issue は最大 **10 件**（多すぎると管理不能）

## Step 4: サマリ報告

全結果をユーザーに報告する。

**報告フォーマット**:

```
## Bug Audit 結果サマリ

### 調査概要
| Dispatch | ステータス | 発見数 |
|----------|----------|--------|
| チャットログ分析 | completed | N 件 |
| ソースコード分析 | completed | N 件 |
| E2E テスト実行 | completed | N 件 |

### 発見されたバグ
| # | Severity | カテゴリ | 説明 | 検出元 |
|---|----------|---------|------|--------|
| (起票された issue 番号) | high | ERROR_HANDLING | ... | sourcecode |

### スキップしたバグ（既存 issue と重複）
| 既存 Issue | 発見内容 |
|-----------|---------|

### Low severity（issue 未起票）
| カテゴリ | 説明 | ファイル |
|---------|------|---------|

### 次のアクション
- <推奨される対応の優先順位>
```
