# /implement-plan — Investigation & Planning (Steps 3-4)

## Step 3: 調査

> **Issue 読み取りは `/read-issue` スキルの手順に準拠する。**
> コマンドやフィールドを変更する場合は `/read-issue` (skills/read-issue/SKILL.md) と同期すること。

### 3a. Issue 全コンテキスト取得

```bash
REPO="${REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
gh issue view <ISSUE_NUMBER> --repo "$REPO" --json number,title,body,labels,state,comments
```

**`VIBE_ADMIRAL` 設定時**: Issue body は prompt の `[Issue Context]` ブロックにも含まれているが、comments・labels・state の最新情報を取得するために上記コマンドを実行する。

### 3b. Comments の解析

全コメントを読み、以下を抽出する:
- 人間からの追加指示やポリシー変更
- 依存関係の追加・変更
- 優先度の変更や要件の追加・修正
- 前回の plan-review で reject された場合のフィードバック

### 3c. 関連 PR の確認

```bash
gh pr list --search "<ISSUE_NUMBER>" --repo "$REPO" --json number,title,state,url
```

### 3d. Dependencies の解析

- `depends-on/<N>` ラベルの確認（labels フィールドから抽出）
- body 内の "## Dependencies" セクションの解析

### 3e. コード調査

その上で:
- Task ツールで並列調査する（影響範囲の特定）
- CLAUDE.md の Conflict Risk Areas を参照する

## Step 4: 計画

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
4. `planning-gate` への直接 DB 更新でフェーズを遷移する:
   ```bash
   sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
   BEGIN;
     UPDATE phases SET phase = 'planning-gate', updated_at = datetime('now')
       WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID';
     UPDATE ships SET phase = 'planning-gate'
       WHERE id = '$VIBE_ADMIRAL_SHIP_ID' AND phase = 'planning';
     INSERT INTO phase_transitions (ship_id, from_phase, to_phase, triggered_by, metadata)
       VALUES ('$VIBE_ADMIRAL_SHIP_ID', 'planning', 'planning-gate', 'ship',
         '{\"planCommentUrl\":\"<comment-url>\",\"qaRequired\":<true or false>}');
   COMMIT;
   "
   ```

**`VIBE_ADMIRAL` 未設定時**:
- EnterPlanMode で実装計画を立てる
- CLAUDE.md の Implementation Layer Order に従って変更レイヤーを分類する

## ステータス遷移

**`VIBE_ADMIRAL` 設定時**: `planning-gate` に直接 DB で遷移し、Escort を起動して plan-review を実施する。

### Escort 起動（plan-review）

`/gate-plan-review` スキルを参照して Escort を Task tool で起動する:

```
Task(description="Escort: plan-review #<issue>", subagent_type="general-purpose", prompt=`
<gate-plan-review スキルの Escort テンプレートに従う>
`)
```

Escort が完了すると、DB の `phases` テーブルが直接更新される。ポーリングして phase 変更を検知（タイムアウト付き単一コマンド）:

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"; SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"; TIMEOUT=300; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do PHASE=$(sqlite3 "$DB_PATH" "SELECT phase FROM phases WHERE ship_id='$SHIP_ID'" 2>/dev/null); case "$PHASE" in implementing) echo "Gate approved"; break ;; planning) echo "Gate rejected"; break ;; planning-gate) sleep 3 ;; *) echo "UNEXPECTED_PHASE: $PHASE"; break ;; esac; ELAPSED=$((ELAPSED + 3)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `implementing` に遷移済み → Escort が承認し phase を更新済み。`/implement-code` に進む
- `planning` に戻された → Escort が reject した。`phase_transitions` からフィードバックを取得して計画を修正、再度 gate に遷移 → Escort 起動ループ:
  ```bash
  FEEDBACK=$(sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
    SELECT json_extract(metadata, '$.feedback')
    FROM phase_transitions
    WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID'
    ORDER BY created_at DESC LIMIT 1
  ")
  ```

## 完了後

workflow-state.json を更新して `/implement-code` に進む。

> **コンテキストリフレッシュ**: Planning phase の調査・試行錯誤でコンテキストが膨らんでいる。
> `/implement-code` の Step 5a で Issue 全文（plan コメント含む）を再読み込みすることで、
> stale な planning コンテキストに頼らずフレッシュな状態で実装を開始する。
