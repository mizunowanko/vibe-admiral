# /implement-code — Implementation & Build Verification (Steps 5-8)

## Step 5: 実装

CLAUDE.md に記載されたレイヤー順序で実装する。

## Step 6: ビルド検証

CLAUDE.md の Commands テーブルに記載されたビルド・テスト・リントコマンドを実行する。
テストやリントが失敗したら修正して再実行する。

## Step 7: 統合

最新のデフォルトブランチをマージし、コンフリクトがあれば解消する。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH" && git merge "origin/$DEFAULT_BRANCH"
```

- コンフリクトが発生したら解消してからコミットする
- **Web プロジェクトの場合**: `npm install` も実行する

## Step 8: テスト再実行

ビルド・テスト・リントを再度実行して統合後の問題がないことを確認する。

## 完了後

workflow-state.json を更新して `/implement-review` に進む。
