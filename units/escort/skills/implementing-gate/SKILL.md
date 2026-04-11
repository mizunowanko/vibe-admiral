---
name: implementing-gate
description: Code-review Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /implementing-gate — Code Review Gate (Engine Escort)

Engine が coding-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID` — この Escort の ID
- `VIBE_ADMIRAL_PARENT_SHIP_ID` — レビュー対象の親 Ship ID
- `VIBE_ADMIRAL_MAIN_REPO` — Fleet のメインリポジトリ（owner/repo）
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API ポート（デフォルト: 9721）

## Procedure

1. セットアップ:
   ```bash
   PARENT_SHIP_ID="${VIBE_ADMIRAL_PARENT_SHIP_ID}"
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   BRANCH_NAME=$(git branch --show-current)
   ```

2. PR を特定:
   ```bash
   PR_JSON=$(gh pr list --head "$BRANCH_NAME" --repo "$REPO" --json number,url --jq '.[0]')
   ```
   PR が見つからない場合は、gate を reject して feedback "PR not found" を書き込む。

3. Ship の実装ログを確認:
   ```bash
   tail -n 300 .claude/ship-log.jsonl 2>/dev/null | grep '"type":"assistant"' | tail -n 30
   ```

4. PR の詳細を取得:
   ```bash
   gh pr view <PR_NUMBER> --repo "$REPO" --json title,body,reviews,comments
   ```

5. レビュー履歴を確認:
   - 既存の "request-changes" レビューがあれば、何が指摘されたか把握

6. diff を取得:
   ```bash
   gh pr diff <PR_NUMBER> --repo "$REPO"
   ```

7. レビュー:
   - Issue 要件の充足
   - コーディング規約の遵守
   - セキュリティリスク
   - スコープの妥当性
   - テストカバレッジ
   - re-review の場合、前回の指摘が修正されているか

8. **GitHub コメント → Gate intent → verdict**:

   Gate API は親 Ship（`PARENT_SHIP_ID`）に対して実行する。`SHIP_ID`（Escort 自身）ではない。

   **8a. GitHub にレビュー結果を記録（verdict より先に実行）**:
   - 承認: `COMMENT_URL=$(gh pr comment <PR_NUMBER> --repo "$REPO" --body "<review summary>")`
   - 拒否: `COMMENT_URL=$(gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "<detailed feedback>")`

   > **注意**: Ship と Escort は同じ GitHub アカウントで動作するため、`gh pr review --approve` / `--request-changes` は「自分の PR を自分でレビューできない」制約で失敗する。PR コメント / Issue コメントを使用する。
   > `gh issue comment` / `gh pr comment` の出力がコメント URL になる。この URL を verdict API に渡す。

   **8b. Gate intent（verdict 前のフォールバック）**:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-intent \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "<approve or reject>"}'
   ```

   **8c. Gate verdict（commentUrl 必須）**:

   承認:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d "{\"verdict\": \"approve\", \"commentUrl\": \"${COMMENT_URL}\"}"
   ```

   拒否（構造化フィードバック付き — ADR-0018。code-review では `file` / `line` フィールドで指摘箇所を特定する）:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d "{
       \"verdict\": \"reject\",
       \"commentUrl\": \"${COMMENT_URL}\",
       \"feedback\": {
         \"summary\": \"<1-2文の要約>\",
         \"items\": [
           {
             \"category\": \"<plan|code|test|style|security|performance>\",
             \"severity\": \"<blocker|warning|suggestion>\",
             \"message\": \"<具体的な指摘内容>\",
             \"file\": \"<対象ファイルパス>\",
             \"line\": \"<対象行番号>\"
           }
         ]
       }
     }"
   ```

   > `blocker` は修正必須、`warning` は推奨、`suggestion` は任意。
   > **IMPORTANT**: `commentUrl` は必須。未指定の場合は 400 エラーとなる。

## Review Guidelines

- Minor style issues are not blockers
- Missing tests for new logic: reject
- Security concerns or data loss risks: reject and escalate to the human
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
