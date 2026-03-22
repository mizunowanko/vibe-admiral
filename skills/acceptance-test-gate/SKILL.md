---
name: acceptance-test-gate
description: Playwright E2E テスト Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /acceptance-test-gate — Playwright E2E Test Gate (Engine Escort)

Engine が acceptance-test-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

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

3. Issue の要件を確認:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body
   ```

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

9. **GitHub にテスト結果を記録**:
   ```bash
   gh pr comment <PR_NUMBER> --repo "$REPO" --body "## Acceptance Test (Playwright E2E)

   <テスト結果サマリ>

   **Verdict: APPROVE** (or REJECT)"
   ```

10. Engine REST API で gate verdict を送信:

    承認の場合:
    ```bash
    curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
      -H 'Content-Type: application/json' \
      -d '{"verdict": "approve"}'
    ```

    拒否の場合:
    ```bash
    curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
      -H 'Content-Type: application/json' \
      -d '{"verdict": "reject", "feedback": "<失敗したテストと修正すべき点>"}'
    ```

## Review Guidelines

- All existing E2E tests must pass
- If no E2E tests exist yet, approve (test coverage is tracked separately)
- Flaky test failures: re-run once before rejecting
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
