# /implement-plan — Investigation & Planning (plan-01〜plan-02)

## plan-01: 調査

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

## plan-02: 計画

**`VIBE_ADMIRAL` 設定時**: EnterPlanMode は使わない。代わりに:

1. 実装計画をテキストとして作成する（変更対象ファイル、実装方針、影響 範囲、テスト方針を含む）
2. **QA 要否を判断する**: Issue の type ラベルと変更内容から、Playwright QA が必要かどうかを判断する:
   - `type/feature` で UI 変更を含む → `qaRequired: true`
   - `type/bug` で UI に影響するバグ → `qaRequired: true`
   - `type/refactor` → `qaRequired: false`
   - `type/infra` → `qaRequired: false`
   - `type/skill` → `qaRequired: false`
   - `type/test` → `qaRequired: false`
   - type ラベルなし or 判断に迷う場合 → `qaRequired: true`（保守的に デフォルト true）
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
   Reason: <判断理由。例: "type/refactor で UI 変更を含まないため QA  不要" or "type/feature で新しい UI コンポーネントを追加するため QA 必 要">

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

**`VIBE_ADMIRAL` 設定時**: `implementing` への遷移を表明。これは `plan-review` Gate をトリガーする。

Gate 待機フローに従い、`.claude/gate-response.json` を待機する。

- `approved: true` → `/implement-code` に進む
- `approved: false` → フィードバックを確認して計画を修正、再度遷移を表明

## 完了後

workflow-state.json を更新して `/implement-code` に進む。
