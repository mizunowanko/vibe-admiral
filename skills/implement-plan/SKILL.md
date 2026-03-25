---
name: implement-plan
description: /implement のサブスキル — 調査 + 計画策定
user-invocable: false
---

# /implement-plan — Investigation & Planning

## Step 1: 調査

> **Issue 読み取りは `/read-issue` スキルの手順に準拠する。**
> コマンドやフィールドを変更する場合は `/read-issue` (skills/read-issue/SKILL.md) と同期すること。

### 1a. Issue 全コンテキスト取得

```bash
REPO="${REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
gh issue view <ISSUE_NUMBER> --repo "$REPO" --json number,title,body,labels,state,comments
```

**`VIBE_ADMIRAL` 設定時**: Issue body は prompt の `[Issue Context]` ブロックにも含まれているが、comments・labels・state の最新情報を取得するために上記コマンドを実行する。

### 1b. Comments の解析

全コメントを読み、以下を抽出する:
- 人間からの追加指示やポリシー変更
- 依存関係の追加・変更
- 優先度の変更や要件の追加・修正
- 前回の plan-review で reject された場合のフィードバック

### 1c. 関連 PR の確認

```bash
gh pr list --search "<ISSUE_NUMBER>" --repo "$REPO" --json number,title,state,url
```

### 1d. Dependencies の解析

- `depends-on/<N>` ラベルの確認（labels フィールドから抽出）
- body 内の "## Dependencies" セクションの解析

### 1e. コード調査

その上で:
- Task ツールで並列調査する（影響範囲の特定）
- CLAUDE.md の Conflict Risk Areas を参照する

## Step 2: 計画

**`VIBE_ADMIRAL` 設定時**: EnterPlanMode は使わない。代わりに:

1. 実装計画をテキストとして作成する（変更対象ファイル、実装方針、影響範囲、テスト方針を含む）
2. **QA 要否を判断する**: Issue の type ラベルと変更内容から、Playwright QA が必要かどうかを判断する:
   - `type/feature` で UI 変更を含む → `qaRequired: true`
   - `type/bug` で UI に影響するバグ → `qaRequired: true`
   - `type/refactor` → `qaRequired: false`
   - `type/infra` → `qaRequired: false`
   - `type/skill` → `qaRequired: false`
   - `type/test` → `qaRequired: false`
   - type ラベルなし or 判断に迷う場合 → `qaRequired: true`（保守的にデフォルト true）
3. **計画を Issue コメントとして投稿する**（QA 判断理由を含む）:
   ```bash
   PLAN_COMMENT_URL=$(gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "$(cat <<'PLANEOF'
   ## Implementation Plan

   ### Changes
   <変更対象ファイル一覧>

   ### Approach
   <実装方針の要約>

   ### Impact Analysis
   <影響範囲の分析>

   ### Test Plan
   <テスト方針>

   ### QA Requirement
   **qaRequired: <true or false>**
   Reason: <判断理由。例: "type/refactor で UI 変更を含まないため QA 不要" or "type/feature で新しい UI コンポーネントを追加するため QA 必要">

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   PLANEOF
   )")
   echo "$PLAN_COMMENT_URL"
   ```
4. `plan-gate` への Engine REST API でフェーズを遷移する:
   ```bash
   curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition \
     -H 'Content-Type: application/json' \
     -d "{\"phase\": \"plan-gate\", \"metadata\": {\"planCommentUrl\": \"<comment-url>\", \"qaRequired\": <true or false>}}"
   ```

**`VIBE_ADMIRAL` 未設定時**:
- EnterPlanMode で実装計画を立てる
- CLAUDE.md の Implementation Layer Order に従って変更レイヤーを分類する

## ステータス遷移

**`VIBE_ADMIRAL` 設定時**: Engine REST API で `plan-gate` に遷移する。Engine が Escort を起動して plan-review を実施する。

### Gate ポーリング（plan-review）

Phase 遷移後、Engine が Escort プロセスを起動する。ポーリングして phase 変更を検知（タイムアウト付き単一コマンド）。
**NOTE: ループ内の `sleep 60` は意図的なポーリング間隔であり、rate limit backoff ではない。遅延があっても rate limit と誤認しないこと。**

```bash
TIMEOUT=900; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do RESULT=$(curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase); PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4); case "$PHASE" in coding) echo "Gate approved"; break ;; plan) echo "Gate rejected"; break ;; plan-gate) sleep 60 ;; *) echo "UNEXPECTED_PHASE: $PHASE"; break ;; esac; ELAPSED=$((ELAPSED + 60)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `coding` に遷移済み → Escort が承認。`/implement-code` に進む
- `plan` に戻された → Escort が reject した。phase-transition-log API からフィードバックを取得して計画を修正、再度 gate に遷移 → Engine が Escort を再起動:
  ```bash
  FEEDBACK=$(curl -sf "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition-log?limit=1" | grep -o '"feedback":"[^"]*"' | cut -d'"' -f4)
  ```

## 完了後

workflow-state.json を更新して `/implement-code` に進む。

> **コンテキストリフレッシュ**: Plan phase の調査・試行錯誤でコンテキストが膨らんでいる。
> `/implement-code` の Step 1a で Issue 全文（plan コメント含む）を再読み込みすることで、
> stale な planning コンテキストに頼らずフレッシュな状態で実装を開始する。
