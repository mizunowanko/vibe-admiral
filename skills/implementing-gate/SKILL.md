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

- `/escort` の Common Setup を参照

## Procedure

1. `/escort` の Common Setup でセットアップ済み。追加:
   ```bash
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

8. **Gate intent → verdict → GitHub 記録**: `/escort` の Common Gate Protocol に従う。code-review では `file` / `line` フィールドで指摘箇所を特定する。

9. **GitHub にレビュー結果を記録**（verdict 送信後に実行 — プロセスが死んでも verdict は保全済み）:
   - 承認: `gh pr comment <PR_NUMBER> --repo "$REPO" --body "<review summary>"`
   - 拒否: `gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "<detailed feedback>"`

   > **注意**: Ship と Escort は同じ GitHub アカウントで動作するため、`gh pr review --approve` / `--request-changes` は「自分の PR を自分でレビューできない」制約で失敗する。PR コメント / Issue コメントを使用する。

## Review Guidelines

- Minor style issues are not blockers
- Missing tests for new logic: reject
- Security concerns or data loss risks: reject and escalate to the human
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
