# /implement-code — Implementation & Build Verification (impl-01〜impl-04)

## impl-01: 実装

CLAUDE.md に記載されたレイヤー順序で実装する。

## impl-02: ビルド検証

CLAUDE.md の Commands テーブルに記載されたビルド・テスト・リントコマンドを実行する。
テストやリントが失敗したら修正して再実行する。

## impl-03: 統合

最新のデフォルトブランチをマージし、コンフリクトがあれば解消する。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH" && git merge "origin/$DEFAULT_BRANCH"
```

- コンフリクトが発生したら解消してからコミットする
- **Web プロジェクトの場合**: `npm install` も実行する

## impl-04: テスト再実行

ビルド・テスト・リントを再度実行して統合後の問題がないことを確認する。

## 完了後

workflow-state.json を更新して `/implement-review` に進む。
