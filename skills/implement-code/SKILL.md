---
name: implement-code
description: /implement のサブスキル — コーディング + テスト実行
user-invocable: false
---

# /implement-code — Implementation & Build Verification

## Step 1: 実装

### 1a. コンテキストリフレッシュ（必須）

Plan phase の調査・試行錯誤でコンテキストが膨らんでいるため、実装開始前に Issue を再読み込みしてコンテキストをリフレッシュする。

```bash
REPO="${REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
ISSUE_NUMBER=<issue-number>
gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json number,title,body,labels,state,comments
```

出力から以下を確認する:
- **Issue 本文**: 最新の要件
- **Implementation Plan コメント**: 承認済みの実装計画（Plan Review で APPROVE された内容）
- **Plan Review コメント**: レビューでの指摘事項（あれば反映する）
- **その他のコメント**: 人間からの追加指示や要件変更

> **なぜこのステップが必要か**: Plan phase で大量の調査・コード探索を行うとコンテキストが圧迫される。承認済みの plan は Issue コメントに永続化されているため、plan + issue 本文を読み直す方が、stale な plan コンテキストを引きずるより効率的。

### 1b. 実装

CLAUDE.md に記載されたレイヤー順序で実装する。

## Step 2: ビルド検証

CLAUDE.md の Commands テーブルに記載されたビルド・テスト・リントコマンドを実行する。
テストやリントが失敗したら修正して再実行する。

## Step 3: 統合

最新のデフォルトブランチをマージし、コンフリクトがあれば解消する。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH" && git merge "origin/$DEFAULT_BRANCH"
```

- コンフリクトが発生したら解消してからコミットする
- **Web プロジェクトの場合**: `npm install` も実行する

## Step 4: テスト再実行

ビルド・テスト・リントを再度実行して統合後の問題がないことを確認する。

## 完了後

workflow-state.json を更新して `/implement-review` に進む。
