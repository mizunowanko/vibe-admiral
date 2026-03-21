---
name: gate-code-review
description: Code-review Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: false
---

# /gate-code-review — Code Review Gate (Engine Escort)

Engine が code-review gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID`: レビュー対象の Ship ID
- `VIBE_ADMIRAL_DB_PATH`: Fleet SQLite データベースパス
- `VIBE_ADMIRAL_MAIN_REPO`: リポジトリ（owner/repo）

## Procedure

1. リポ情報を取得:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   DB_PATH="$VIBE_ADMIRAL_DB_PATH"
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

8. **GitHub にレビュー結果を記録**:
   - 承認: `gh pr review <PR_NUMBER> --repo "$REPO" --approve --body "<review summary>"`
   - 拒否: `gh pr review <PR_NUMBER> --repo "$REPO" --request-changes --body "<detailed feedback>"`

9. DB に gate-response を書き込み:

   承認の場合:
   ```bash
   sqlite3 "$DB_PATH" "INSERT INTO messages (ship_id, type, sender, payload) VALUES ('$SHIP_ID', 'gate-response', 'escort', '{\"approved\":true,\"gatePhase\":\"implementing-gate\"}')"
   ```

   拒否の場合:
   ```bash
   sqlite3 "$DB_PATH" "INSERT INTO messages (ship_id, type, sender, payload) VALUES ('$SHIP_ID', 'gate-response', 'escort', '{\"approved\":false,\"gatePhase\":\"implementing-gate\",\"feedback\":\"<修正すべき点>\"}')"
   ```

## Review Guidelines

- Minor style issues are not blockers
- Missing tests for new logic: reject
- Security concerns or data loss risks: reject and escalate to the human
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
