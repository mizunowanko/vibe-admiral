# /implement-plan — Investigation & Planning (Steps 3-4)

## Step 3: 調査

まず Issue の body と全 comments を読んで要件を完全に把握する:
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
2. **計画を Issue コメントとして投稿する**:
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

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   PLANEOF
   )")
   echo "$PLAN_COMMENT_URL"
   ```
3. `implementing` への status-transition に `planCommentUrl` を含めて遷移を表明する

**`VIBE_ADMIRAL` 未設定時**:
- EnterPlanMode で実装計画を立てる
- CLAUDE.md の Implementation Layer Order に従って変更レイヤーを分類する

## ステータス遷移

**`VIBE_ADMIRAL` 設定時**: `implementing` への遷移を表明。これは `plan-review` Gate をトリガーする。

````
```admiral-request
{ "request": "status-transition", "status": "implementing", "planCommentUrl": "<comment-url>" }
```
````

Gate 待機フローに従い、`.claude/gate-response.json` を待機する。

- `approved: true` → `/implement-code` に進む
- `approved: false` → フィードバックを確認して計画を修正、再度遷移を表明

## 完了後

workflow-state.json を更新して `/implement-code` に進む。
