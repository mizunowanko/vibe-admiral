---
name: implement-code
description: /implement のサブスキル — コーディング + テスト実行
user-invocable: false
---

# /implement-code — Implementation & Build Verification

## Step 1: 実装

### 1a. コンテキストリフレッシュ（必須）

Planning phase の調査・試行錯誤でコンテキストが膨らんでいるため、実装開始前に Issue を再読み込みしてコンテキストをリフレッシュする。

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

> **なぜこのステップが必要か**: Planning phase で大量の調査・コード探索を行うとコンテキストが圧迫される。承認済みの plan は Issue コメントに永続化されているため、plan + issue 本文を読み直す方が、stale な planning コンテキストを引きずるより効率的。

### 1b. 実装

CLAUDE.md に記載されたレイヤー順序で実装する。

## Step 2: ビルド検証

CLAUDE.md の Commands テーブルに記載されたビルド・テスト・リントコマンドを実行する。
テストやリントが失敗したら修正して再実行する。

## Step 3: 統合

最新のデフォルトブランチと統合する。競合の規模に応じて段階的に戦略をエスカレーションする。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH"
```

### 段階 1: 通常の merge（推奨）

```bash
git merge "origin/$DEFAULT_BRANCH"
```

- 競合なし → そのまま Step 4 へ
- 少数の競合（1-3 ファイル）→ 手動で解消してコミット
- 多数の競合（4+ ファイル）→ abort して段階 2 へ

### 段階 2: rebase（rename 追跡を活かす）

大規模リファクタで rename が含まれる場合、rebase の方が git の rename 追跡が効き、競合が減ることがある。

```bash
git merge --abort 2>/dev/null  # 段階 1 の競合を破棄
git rebase "origin/$DEFAULT_BRANCH"
```

- 競合なし or 少数 → 手動で解消して `git rebase --continue`
- 多数の競合が残る → `git rebase --abort` して段階 3 へ

### 段階 3: merge commit にフォールバック

rebase でも競合が多い場合は、merge commit を使う。squash merge する PR では最終的にコミット履歴は圧縮されるため、merge commit でも問題ない。

```bash
git rebase --abort 2>/dev/null  # 段階 2 の rebase を破棄
git merge "origin/$DEFAULT_BRANCH"
```

この段階では競合を 1 つずつ手動で解消する。解消の指針:
- **main 側が正しい場合**: main の変更を採用（例: main で修正された import パス）
- **feature branch 側が正しい場合**: feature の変更を維持
- **両方の変更が必要な場合**: 手動でマージ
- **rename 競合の場合**: rename 先のファイルに main の変更内容を手動で反映

> **コンテキスト節約のコツ**: 競合ファイルが多い場合、`git diff --name-only --diff-filter=U` で競合ファイル一覧を確認し、パターンが同じ競合はまとめて解消する。

- 全ての競合を解消後: `git add <resolved-files> && git commit`
- **Web プロジェクトの場合**: `npm install` も実行する

## Step 4: テスト再実行

ビルド・テスト・リントを再度実行して統合後の問題がないことを確認する。

## 完了後

workflow-state.json を更新して `/implement-review` に進む。
