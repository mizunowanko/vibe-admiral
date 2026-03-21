# /implement-merge — CI, Review, Merge & Cleanup (merge-01〜merge-05)

## merge-01: CI パス確認

```bash
PR_NUM=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
gh pr checks "$PR_NUM" --watch
```

- CI が全てパスしたら merge-02 へ
- CI が失敗した場合は merge-05（CI 修正ループ）へ
- **CI が未設定の場合**（`no checks reported`）: スキップして merge-02 へ

## merge-02: レビュー結果の対応（マージ前に必須）

**このステップを完了するまで絶対に merge-03 に進んではならない。**

### VIBE_ADMIRAL 設定時（Gate 方式）

review-02 で code-review Gate の approve/reject 対応が完了しているため、そのまま merge-03 へ。

### VIBE_ADMIRAL 未設定時

バックグラウンドのレビュー結果を確認する（Read ツールで output_file を確認）。
レビューエージェントがまだ実行中なら完了を待機する。

指摘の分類:
- **BLOCKER**: この PR で修正必要 → 修正 → commit & push → merge-01 に戻る
- **NICE TO HAVE**: 別 Issue で対応 → `gh issue create --label status/todo`
- **NO NEED**: 対応不要
- **LGTM**: merge-03 へ

## merge-03: マージ

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

## merge-04: 完了表明と掃除

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

## merge-05: CI 失敗時の修正ループ

1. `gh run view <run-id> --log-failed` で失敗ログを取得
2. エラーを分析
3. ローカルで修正（CLAUDE.md の Commands テーブル参照）
4. 修正をコミット & push
5. merge-01 に戻る

## CI 失敗ログの取得方法

```bash
gh run list --limit=3
gh run view <run-id> --log-failed
```
