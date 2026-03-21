# /implement-merge — CI, Acceptance Test, Merge & Cleanup (Steps 11-16)

> **CRITICAL: Step 11 → Step 12 → Step 14 → Step 15 の順序は絶対にスキップ・逆転してはならない。**

## Step 11: 受け入れテスト

> **前提条件**: `/implement-review` の Step 10 (code-review Gate) が完了していること。

### QA スキップ判定

Step 4 で `qaRequired: false` と判断した場合、**このステップ全体をスキップして Step 12 に進む**。

### VIBE_ADMIRAL 設定時（ファイル伝言板方式）

1. 空きポートを取得してアプリを起動。**listen 状態になるまで待機してから** `.claude/acceptance-test-request.json` を作成:
   ```bash
   PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
   PORT=$PORT npm run dev  # run_in_background: true
   ```
   ```bash
   echo "Waiting for dev server to start on port $PORT..."
   for i in $(seq 1 30); do
     if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT" 2>/dev/null | grep -qE '^[1-9]'; then
       echo "Dev server is ready on port $PORT"
       break
     fi
     if [ $i -eq 30 ]; then echo "WARNING: Dev server did not start within 30s on port $PORT"; fi
     sleep 1
   done
   ```
   ```bash
   cat > .claude/acceptance-test-request.json << ATEOF
   {
     "url": "http://localhost:$PORT",
     "checks": ["確認ポイント1", "確認ポイント2"]
   }
   ATEOF
   ```

2. `.claude/acceptance-test-response.json` の出現を待機:
   ```bash
   echo "Waiting for acceptance test response..."
   while [ ! -f .claude/acceptance-test-response.json ]; do sleep 2; done
   cat .claude/acceptance-test-response.json
   ```

3. レスポンスに基づいて処理:
   - `accepted: true` → アプリ停止 → Step 12 へ
   - `accepted: false` → 修正 → commit & push → request/response 削除 → 再度 request 作成

### VIBE_ADMIRAL 未設定時

1. 空きポートを取得してアプリを起動（`run_in_background: true`）
2. dev server の listen 待機
3. `open http://localhost:$PORT` でブラウザを開く
4. AskUserQuestion で確認依頼
5. OK → アプリ停止 → Step 12 へ
6. NG → 修正 → commit & push → 2回目以降は E2E テスト追加 → 再確認ループ

## Step 12: CI パス確認

```bash
PR_NUM=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
gh pr checks "$PR_NUM" --watch
```

- CI が全てパスしたら Step 14 へ
- CI が失敗した場合は Step 16（CI 修正ループ）へ
- **CI が未設定の場合**（`no checks reported`）: スキップして Step 14 へ

## Step 14: レビュー結果の対応（マージ前に必須）

**このステップを完了するまで絶対に Step 15 に進んではならない。**

### VIBE_ADMIRAL 設定時（Gate 方式）

Step 10 で code-review Gate の approve/reject 対応が完了しているため、そのまま Step 15 へ。

### VIBE_ADMIRAL 未設定時

バックグラウンドのレビュー結果を確認する（Read ツールで output_file を確認）。
レビューエージェントがまだ実行中なら完了を待機する。

指摘の分類:
- **BLOCKER**: この PR で修正必要 → 修正 → commit & push → Step 12 に戻る
- **NICE TO HAVE**: 別 Issue で対応 → `gh issue create --label status/todo`
- **NO NEED**: 対応不要
- **LGTM**: Step 15 へ

## Step 15: マージ

**`VIBE_ADMIRAL` 設定時**: `merging` への遷移を表明。`playwright` Gate をトリガーする:

````
```admiral-request
{ "request": "status-transition", "status": "merging" }
```
````

```bash
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
RESPONSE=$(cat .claude/admiral-request-response.json)
rm -f .claude/admiral-request-response.json
echo "$RESPONSE"
```

Gate 発動時は Gate 待機フローに従う。Gate 承認後、マージを実行:

```bash
gh pr merge "$PR_NUM" --squash
```

- `--delete-branch` は付けない（worktree と競合するため）
- マージ後の `already used by worktree` エラーは、`gh pr view --json state --jq '.state'` が `MERGED` なら無視

## Step 15.5: 完了表明と掃除

**`VIBE_ADMIRAL` 設定時**: `done` ステータスを表明:

````
```admiral-request
{ "request": "status-transition", "status": "done" }
```
````

```bash
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
cat .claude/admiral-request-response.json
rm -f .claude/admiral-request-response.json
```

1. workflow-state.json の削除:
   ```bash
   rm -f .claude/workflow-state.json
   ```

**`VIBE_ADMIRAL` 未設定の場合のみ**:

2. Worktree 削除:
   ```bash
   REPO_ROOT=$(git worktree list | head -1 | awk '{print $1}')
   WORKTREE_PATH=$(git rev-parse --show-toplevel)
   cd "$REPO_ROOT" && git worktree remove "$WORKTREE_PATH" --force
   ```

3. GH Issue を close:
   ```bash
   ISSUE_NUM=$(echo "<branch-name>" | sed -E 's#(feature|refactor)/([0-9]+)-.+#\2#')
   gh issue close "$ISSUE_NUM" --comment "Closed via PR merge"
   ```

4. デプロイ確認（存在する場合）:
   ```bash
   DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   RUN_ID=$(gh run list --branch "$DEFAULT_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch $RUN_ID
   ```

## Step 16: CI 失敗時の修正ループ

1. `gh run view <run-id> --log-failed` で失敗ログを取得
2. エラーを分析
3. ローカルで修正（CLAUDE.md の Commands テーブル参照）
4. 修正をコミット & push
5. Step 12 に戻る

## CI 失敗ログの取得方法

```bash
gh run list --limit=3
gh run view <run-id> --log-failed
```
