# /implement-review — Commit, PR, Code Review & Acceptance Test (Steps 9-11)

## Step 9: コミット & PR

まず `gh pr list --head $(git branch --show-current) --json number --jq '.[0].number'` で既存 PR の有無を確認する。

**PR が存在しない場合**:

1. `git status && git diff --stat && git diff` で変更を把握
2. 変更を論理的にグルーピングしてコミット（共通 CLAUDE.md のコミット規約に従う）
   - `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` を含める
   - `git add -A` は使わない（ファイル名指定）
3. `git push -u origin <current-branch>` で push
4. ブランチ名から Issue 番号を抽出し、PR を作成:
   ```bash
   gh pr create --base "$DEFAULT_BRANCH" --title "<Issue タイトル>" --body "$(cat <<'EOF'
   ## Summary
   <変更内容の要約>

   ## Changes
   <コミット内容の箇条書き>

   Ref #<Issue 番号>

   ## Test plan
   <ビルド・テスト・リントコマンドの実行結果>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

**PR が既に存在する場合**: 未 push のコミットがあれば `git push` のみ。

PR URL をユーザーに報告する。

### ステータス遷移（VIBE_ADMIRAL 設定時）

PR 作成後、`acceptance-test` への遷移を表明。これは `code-review` Gate をトリガーする:

````
```admiral-request
{ "request": "status-transition", "status": "acceptance-test" }
```
````

```bash
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
RESPONSE=$(cat .claude/admiral-request-response.json)
rm -f .claude/admiral-request-response.json
echo "$RESPONSE"
```

Gate 発動時は Gate 待機フローに従う。

## Step 10: コードレビュー（CI 並行）

### VIBE_ADMIRAL 設定時（Gate 方式）

Step 9 で code-review Gate が発動し、Bridge が自動で PR コードレビューを実施。
Ship は Gate 待機フローに従い `gate-response.json` を待機する。

- `approved: true` → Step 11 へ
- `approved: false` → PR レビューコメントを確認、修正 → commit & push → 再度 `status-transition` で `acceptance-test` を表明

### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動（Task ツール `run_in_background: true`）
2. Step 11 へ進む

## Step 11: 受け入れテスト

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
   - `accepted: true` → アプリ停止 → `/implement-merge` へ
   - `accepted: false` → 修正 → commit & push → request/response 削除 → 再度 request 作成

### VIBE_ADMIRAL 未設定時

1. 空きポートを取得してアプリを起動（`run_in_background: true`）
2. dev server の listen 待機
3. `open http://localhost:$PORT` でブラウザを開く
4. AskUserQuestion で確認依頼（確認ポイントは変更内容から自動生成）
5. OK → アプリ停止 → `/implement-merge` へ
6. NG → 修正 → commit & push → 2回目以降は E2E テスト追加 → 再確認ループ
7. 3回以上 NG → `/second-opinion` を検討

## 完了後

workflow-state.json を更新して `/implement-merge` に進む。
