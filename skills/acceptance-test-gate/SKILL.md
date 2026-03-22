---
name: acceptance-test-gate
description: Acceptance-test Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /acceptance-test-gate — Acceptance Test Gate (Engine Escort)

Engine が acceptance-test-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。
Playwright E2E テストを実行し、Issue の受け入れ基準と照合して、結果を PR コメントに書き込む。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID`: テスト対象の Ship ID
- `VIBE_ADMIRAL_MAIN_REPO`: リポジトリ（owner/repo）
- `VIBE_ADMIRAL_ENGINE_PORT`: Engine API ポート（default: 9721）

## Procedure

1. リポ情報を取得:
   ```bash
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

3. Issue の全コンテキストを取得:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body,comments
   ```
   - Issue 本文の「受け入れ基準」セクションを特定する
   - Implementation Plan コメントからテスト方針を把握する

4. E2E テスト環境を準備:
   ```bash
   npm install
   npx playwright install --with-deps chromium
   ```

5. アプリをビルド & 起動:
   ```bash
   npm run build 2>&1 | tail -20
   npm run preview &
   APP_PID=$!
   sleep 5
   ```

6. Playwright E2E テストを実行:
   ```bash
   npx playwright test 2>&1
   TEST_EXIT=$?
   ```

7. アプリを停止:
   ```bash
   kill $APP_PID 2>/dev/null
   ```

8. テスト結果を判定:
   - `TEST_EXIT=0` → 全テスト合格
   - `TEST_EXIT≠0` → テスト失敗あり
   - Issue の受け入れ基準の各項目について、Playwright テスト結果と diff の内容から充足度を評価する

9. **結果を PR コメントとして書き込む**:

   以下のフォーマットで PR コメントを投稿する:
   ```bash
   gh pr comment <PR_NUMBER> --repo "$REPO" --body "<formatted result>"
   ```

   コメントのフォーマット:
   ```markdown
   ## Acceptance Test Result: ✅ PASS / ❌ FAIL

   ### テスト項目
   - [x] テスト項目 1（pass の場合）
   - [x] テスト項目 2（pass の場合）
   - [ ] テスト項目 3（fail の場合）

   ### 詳細
   <details>
   <summary>検証ログ</summary>

   各テスト項目の検証内容と結果の詳細をここに記載する。
   - どのテストファイル・テストケースを確認したか
   - Playwright テスト実行の出力サマリ
   - Issue 受け入れ基準との対応関係
   - fail の場合は具体的な不足点

   </details>

   ### 判定
   **APPROVE** / **REQUEST CHANGES** — 判定理由の説明

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   ```

   > **重要**: ヘッダーの `✅ PASS` / `❌ FAIL` は全テスト項目の結果に基づいて決定する。
   > 1 つでも fail があれば `❌ FAIL` とする。

10. Engine REST API で gate verdict を送信:

    承認の場合（全テスト項目 pass）:
    ```bash
    curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
      -H 'Content-Type: application/json' \
      -d '{"verdict": "approve"}'
    ```

    拒否の場合（1 つ以上の項目が fail）:
    ```bash
    curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
      -H 'Content-Type: application/json' \
      -d '{"verdict": "reject", "feedback": "<fail した項目と修正すべき点の要約>"}'
    ```

## Test Guidelines

- All existing E2E tests must pass
- If no E2E tests exist yet, approve (test coverage is tracked separately)
- Flaky test failures: re-run once before rejecting
- 受け入れ基準が明示されていない場合は、Issue タイトルと本文から暗黙の基準を推定する
- For re-tests: 前回 fail した項目が修正されているかを重点的に確認する。修正済みなら pass に切り替える
