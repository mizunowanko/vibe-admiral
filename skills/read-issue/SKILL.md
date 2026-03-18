# /read-issue — Issue Full Context Reader

Bridge/Ship 共通の Issue 全コンテキスト取得スキル。
トリガー: Issue の要件を完全に把握する必要があるとき。

## 引数

- Issue 番号（必須）
- `--repo <repo>` （省略時はカレントリポ）

## 手順

### 1. Issue 本体の取得

```bash
REPO="${REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
gh issue view <number> --repo "$REPO" --json number,title,body,labels,state,comments
```

### 2. Comments の解析

全コメントを読み、以下を抽出する:
- 要件の変更・追加・撤回
- 優先度のオーバーライド
- 依存関係の更新
- 人間の意思決定
- 前回の Ship の作業結果（計画レビュー、コードレビュー等）

### 3. 関連 PR の確認

```bash
gh pr list --search "<issue-number>" --repo "$REPO" --json number,title,state,url
```

### 4. Dependencies の解析

- `depends-on/<N>` ラベルの確認
- body 内の "## Dependencies" セクションの解析

### 5. 出力フォーマット

以下の形式で統合結果を出力する:

- **要件**: body + comments から統合した最新の要件
- **コメント要約**: 重要な意思決定・変更のみ抜粋
- **依存関係**: ブロッカーの有無
- **関連 PR**: 既存 PR の状態
- **前回の作業**: 過去の Ship による計画・レビュー・実装の履歴

## 重要

- **body だけで判断しない**。後のコメントが要件を上書き・修正している可能性がある
- 特に plan-review や code-review で reject された場合、その feedback は最新コメントに含まれている
