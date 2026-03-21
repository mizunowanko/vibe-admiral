# /implement-review — Commit, PR & Code Review (Steps 9-10)

> **CRITICAL: Step 9 → Step 10 の順序は絶対にスキップ・逆転してはならない。**
> code-review Gate が承認されてから次の sub-skill に進む。

## Step 9: コミット & PR 作成

まず `gh pr list --head $(git branch --show-current) --json number --jq '.[0].number'` で既存 PR の有無を確認する。

**PR が存在しない場合**:

1. `git status && git diff --stat && git diff` で変更を把握
2. 変更を論理的にグルーピングしてコミット（共通 CLAUDE.md のコミット規約に従う）
   - `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` を含め る
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

**PR が既に存在する場合**: 未 push のコミットがあれば `git push` のみ 。

PR URL をユーザーに報告する。

## Step 10: code-review Gate

> **このステップで code-review Gate が承認されるまで、次の sub-skill (`/implement-merge`) に進んではならない。**

### VIBE_ADMIRAL 設定時（Gate 方式）

PR 作成/push 完了後、`acceptance-test` への遷移を表明する。Engine はこの遷移に対して **code-review Gate** を発動する:

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

Gate 発動後、Bridge が自動で PR コードレビューを実施する。
Ship は Gate 待機フローに従い `gate-response.json` を待機する:

```bash
echo "Gate check initiated. Waiting for Bridge approval..."
rm -f .claude/admiral-request-response.json
while [ ! -f .claude/gate-response.json ]; do sleep 2; done
GATE_RESULT=$(cat .claude/gate-response.json)
rm -f .claude/gate-response.json
rm -f .claude/gate-request.json
echo "$GATE_RESULT"
```

- `approved: true` → `/implement-merge` に進む
- `approved: false` → PR レビューコメントを確認し修正 → commit & push → 再度 `status-transition` で `acceptance-test` を表明 → Gate 待機を繰り返す

### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動（Task ツール `run_in_background: true`）
2. `/implement-merge` に進む（レビュー結果は Step 14 で対応）

## 完了後

workflow-state.json を更新して `/implement-merge` に進む。
