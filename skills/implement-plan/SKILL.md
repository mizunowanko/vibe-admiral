# /implement-plan — Investigation & Planning (Steps 3-4)

## Step 3: 調査

**`VIBE_ADMIRAL` 設定時**: Issue body は prompt の `[Issue Context]` ブロックに含まれている。body の再取得は不要。comments のみ取得して追加指示を確認する:
```bash
gh issue view <ISSUE_NUMBER> --repo "$REPO" --json comments --jq '.comments'
```

**`VIBE_ADMIRAL` 未設定時**: Issue の body と全 comments を読んで要件を完全に把握する:
```bash
gh issue view <ISSUE_NUMBER> --repo "$REPO" --json body,comments
```

特に以下を確認する:
- 人間からの追加指示やポリシー変更
- 依存関係の追加・変更
- 優先度の変更や要件の追加・修正
- 前回の plan-review で reject された場合のフィードバック

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
4. `implementing` への status-transition に `planCommentUrl` と `qaRequired` を含めて遷移を表明する:
   ````
   ```admiral-request
   { "request": "status-transition", "status": "implementing", "planCommentUrl": "<comment-url>", "qaRequired": <true or false> }
   ```
   ````

**`VIBE_ADMIRAL` 未設定時**:
- EnterPlanMode で実装計画を立てる
- CLAUDE.md の Implementation Layer Order に従って変更レイヤーを分類する

## ステータス遷移

**`VIBE_ADMIRAL` 設定時**: `implementing` への遷移を表明。Engine はこの遷移に対して gate 応答を返す。

Engine からの応答を DB でポーリング（タイムアウト付き単一コマンド）:

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"; SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"; TIMEOUT=120; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do ROW=$(sqlite3 "$DB_PATH" "SELECT payload FROM messages WHERE ship_id='$SHIP_ID' AND type='admiral-request-response' AND read_at IS NULL LIMIT 1" 2>/dev/null); if [ -n "$ROW" ]; then sqlite3 "$DB_PATH" "UPDATE messages SET read_at=datetime('now') WHERE ship_id='$SHIP_ID' AND type='admiral-request-response' AND read_at IS NULL"; echo "$ROW"; break; fi; sleep 2; ELAPSED=$((ELAPSED + 2)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

応答に `gate` フィールドが含まれる場合、Ship 自身が Escort (sub-agent) を起動して plan-review を実施する。

### Escort 起動（plan-review）

`/gate-plan-review` スキルを参照して Escort を Task tool で起動する:

```
Task(description="Escort: plan-review #<issue>", subagent_type="general-purpose", prompt=`
<gate-plan-review スキルの Escort テンプレートに従う>
`)
```

Escort が完了すると、DB に `gate-response` が書き込まれる。ポーリングして結果を取得（タイムアウト付き単一コマンド）:

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"; SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"; TIMEOUT=300; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do ROW=$(sqlite3 "$DB_PATH" "SELECT payload FROM messages WHERE ship_id='$SHIP_ID' AND type='gate-response' AND read_at IS NULL LIMIT 1" 2>/dev/null); if [ -n "$ROW" ]; then sqlite3 "$DB_PATH" "UPDATE messages SET read_at=datetime('now') WHERE ship_id='$SHIP_ID' AND type='gate-response' AND read_at IS NULL"; echo "$ROW"; break; fi; sleep 3; ELAPSED=$((ELAPSED + 3)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `approved: true` → 再度 `status-transition` を表明して Engine に gate 完了を通知、`/implement-code` に進む
- `approved: false` → GitHub のフィードバックを確認して計画を修正、再度 `status-transition` → Escort 起動ループ

### Gate 完了通知

Gate 承認後、再度 `status-transition` を表明して Engine に gate 完了を通知:

````
```admiral-request
{ "request": "status-transition", "status": "implementing" }
```
````

Engine からの `{ok: true}` 応答を DB でポーリングして確認。

## 完了後

workflow-state.json を更新して `/implement-code` に進む。

> **コンテキストリフレッシュ**: Planning phase の調査・試行錯誤でコンテキストが膨らんでいる。
> `/implement-code` の Step 5a で Issue 全文（plan コメント含む）を再読み込みすることで、
> stale な planning コンテキストに頼らずフレッシュな状態で実装を開始する。
