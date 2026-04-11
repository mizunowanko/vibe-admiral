---
name: e2e-audit
description: E2E テストカバレッジ調査・実行・バグ起票の一連フロー
user-invocable: true
argument-hint: []
---

# /e2e-audit — E2E Test Audit & Enforcement

トリガー: E2E テストのカバレッジ確認、テスト実行、失敗分析が必要なとき。

## モックなし方針

本プロジェクトの E2E テストは**モックを使わない**。

- **実 Engine**: Node.js Engine サイドカーを実際に起動
- **Stub CLI**: Claude Code CLI の代わりに `test-utils/stub-cli.ts` を使用。phase 遷移を確定的にシミュレート
- **実 WebSocket**: Frontend ↔ Engine 間の WS 通信は実際の接続

> モックを使わない理由: モック/本番の乖離によるテスト偽陽性を防止する（ADR-0013 参照）。Stub CLI は CLI の振る舞いだけを差し替え、Engine・WS・Frontend は本物を使う。

## テスト増強チェックリスト

Dispatch による調査では、以下の観点でカバレッジギャップを特定する:

- [ ] **Ship phase 遷移の網羅**: plan → plan-gate → coding → coding-gate → qa → qa-gate → merging → done の全遷移
- [ ] **Fleet 切り替え時の状態保持**: Fleet 間遷移でチャット・Ship 一覧が混在しないこと
- [ ] **Commander の操作フロー**: sortie（出撃）、stop（停止）、resume（再開）の各操作
- [ ] **Dispatch の起動→完了フロー**: `POST /api/dispatch` → 実行 → 完了通知の一連
- [ ] **WS 切断→再接続**: Engine 再起動後の状態復元、WS reconnect

## ワークフロー

### Step 1: カバレッジ調査（Dispatch）

Dispatch を起動して現状の E2E テストカバレッジを調査する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "e2e-coverage-audit",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent auditing E2E test coverage.\n\nRepo: <repo-path>\n\nSteps:\n1. List all E2E test files in e2e/ directory (glob: e2e/**/*.spec.ts)\n2. For each test file, read it and summarize:\n   - Test name (describe/test blocks)\n   - What functionality it verifies\n   - Key assertions\n3. List all Engine API endpoints from engine/src/api-server.ts\n4. List all UI operation flows from src/components/ (fleet creation, ship sortie, ship management, commander chat)\n5. Cross-reference: identify functionality that has NO E2E test coverage\n\nCheck coverage against these critical areas:\n- Ship phase transitions (plan → plan-gate → coding → coding-gate → qa → qa-gate → merging → done)\n- Fleet switching and state isolation\n- Commander operations (sortie, stop, resume)\n- Dispatch launch → completion flow\n- WebSocket disconnect → reconnect\n\nOUTPUT FORMAT:\n## Existing Tests\n| Test File | Coverage Area | Key Assertions |\n|-----------|--------------|----------------|\n\n## Untested Areas\n| Area | Priority | Reason |\n|------|----------|--------|\n\n## Recommendations\n- Numbered list of recommended new tests\n\nDo NOT create issues or make changes. Only investigate and report."
  }'
```

Dispatch 完了を待ち、結果を確認する:

```bash
curl -s "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatches?fleetId=<fleet-id>" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(x['result']) for x in d.get('dispatches',[]) if x['name']=='e2e-coverage-audit' and x['status']=='completed']"
```

### Step 2: テスト追加 issue 起票

Step 1 の結果から、テスト不足箇所ごとに issue を起票する。

**Issue フォーマット（テスト追加）**:

```bash
gh issue create \
  --title "test: E2E — <テスト対象の機能名>" \
  --label "type/test" \
  --body "$(cat <<'ISSUEEOF'
## 概要

<テスト対象機能の説明>

## テストケース

- [ ] <テストケース 1: 具体的なシナリオ>
- [ ] <テストケース 2: 具体的なシナリオ>
- [ ] <テストケース 3: エッジケース>

## テスト設計

- **テストファイル**: `e2e/<filename>.spec.ts`
- **セットアップ**: <必要な前提条件（Stub CLI モード、シードデータ等）>
- **検証方法**: <アサーションの方針>

## 関連

- #780 — E2E テスト基盤
- #901 — E2E テスト増強スキル
ISSUEEOF
)"
```

### Step 3: テスト実行（Dispatch）

Dispatch を起動して E2E テストを実行する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "e2e-test-execution",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent running E2E tests.\n\nRepo: <repo-path>\n\nSteps:\n1. Run all E2E tests:\n   npx playwright test --config playwright.e2e.config.ts 2>&1\n2. If tests fail, capture:\n   - Test name\n   - Error message\n   - Stack trace (first 10 lines)\n   - Screenshot path (if any)\n3. Run failed tests individually for detailed output:\n   npx playwright test --config playwright.e2e.config.ts <test-file> 2>&1\n\nOUTPUT FORMAT:\n## Test Results\n- **Total**: N tests\n- **Passed**: N\n- **Failed**: N\n- **Skipped**: N\n\n## Failures (if any)\n### <Test Name>\n- **File**: <path>\n- **Error**: <error message>\n- **Stack**: <first 5 lines>\n- **Category**: BUG (application bug) | TEST_ISSUE (test itself is broken) | FLAKY (intermittent)\n- **Reasoning**: <why this category>\n\nDo NOT create issues or make changes. Only run tests and report."
  }'
```

### Step 4: 失敗分析

Dispatch の結果を確認し、各失敗を以下のカテゴリに分類する:

| カテゴリ | 判定基準 | アクション |
|---------|---------|-----------|
| **BUG** | アプリケーションコードの不具合 | Step 5 でバグ issue 起票 |
| **TEST_ISSUE** | テストコード自体の問題（セレクタ変更、タイミング等） | Step 6 でテスト修正 issue 起票 |
| **FLAKY** | 間欠的な失敗（タイミング依存） | Step 6 でテスト修正 issue 起票（安定化） |

### Step 5: バグ issue 起票

**Issue フォーマット（バグ）**:

```bash
gh issue create \
  --title "bug: <バグの簡潔な説明>" \
  --label "type/bug" \
  --body "$(cat <<'ISSUEEOF'
## 概要

E2E テスト実行で発見されたバグ。

## 再現手順

1. <手順 1>
2. <手順 2>
3. <手順 3>

## 期待動作

<正しい動作>

## 実際の動作

<観測された動作>

## エラー情報

- **失敗テスト**: `e2e/<test-file>.spec.ts` — "<test-name>"
- **エラーメッセージ**: `<error message>`
- **スタックトレース**:
```
<stack trace (5 lines)>
```

## 関連

- #901 — E2E テスト増強スキル
ISSUEEOF
)"
```

### Step 6: テスト修正 issue 起票

**Issue フォーマット（テスト修正）**:

```bash
gh issue create \
  --title "test: E2E — <テスト名> の修正" \
  --label "type/test" \
  --body "$(cat <<'ISSUEEOF'
## 概要

E2E テストの修正が必要。

## 問題

- **テストファイル**: `e2e/<test-file>.spec.ts`
- **テスト名**: "<test-name>"
- **問題の種類**: <TEST_ISSUE | FLAKY>
- **原因**: <原因の説明>

## 修正方針

<修正アプローチの説明>

## 関連

- #901 — E2E テスト増強スキル
ISSUEEOF
)"
```

### Step 7: サマリ報告

全ステップの結果をユーザーに報告する。

**報告フォーマット**:

```
## E2E Audit 結果サマリ

### カバレッジ
- 既存テスト数: N 本
- テスト対象機能数: N
- カバレッジギャップ: N 箇所

### テスト実行結果
- 合計: N テスト
- 成功: N
- 失敗: N（バグ: N、テスト問題: N、Flaky: N）

### 起票した Issue
| Issue | タイプ | タイトル |
|-------|--------|---------|
| #xxx  | type/test | ... |
| #xxx  | type/bug  | ... |

### 次のアクション
- <推奨される次のステップ>
```
