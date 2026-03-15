---
name: implement
description: Issue ベースの機能実装ワークフロー。調査→計画→実装→テスト→コミット→PR→レビュー→受け入れテスト→CI→マージまで一気通貫で実行する。"/implement", "実装して" などで起動。
user-invocable: true
---

# /implement — 統合実装スキル

GitHub Issues をベースに、機能実装→テスト→レビュー→マージまでを一気通貫で行うスキル。
dev-shared の /feature + /cleanup を統合したもの。

## 引数

- Issue 番号（例: `#42`, `42`）または Issue タイトルの一部（省略可）
  - 省略時は GH Issue 一覧から unblocked かつ `status/todo` ラベルのものを自動選択する

## CRITICAL: Resume Check

ワークフロー開始前に `.claude/workflow-state.json` を確認する。
存在する場合は `currentStep` から再開する。存在しない場合は Step 1 から開始する。
各ステップ完了時に state file を更新する（Bash で書き込み）。

```bash
# 確認
cat .claude/workflow-state.json 2>/dev/null || echo "NO_STATE"
```

### workflow-state.json 形式

```json
{
  "skill": "implement",
  "issueNumber": 42,
  "currentStep": 5,
  "completedSteps": [1, 2, 3, 4],
  "branchName": "feature/42-add-login",
  "prNumber": null,
  "reviewTaskId": null,
  "acceptanceTestAttempts": 0
}
```

### State 更新テンプレート

各ステップ完了後に実行する:
```bash
cat > .claude/workflow-state.json << 'STATEEOF'
{
  "skill": "implement",
  "issueNumber": <NUMBER>,
  "currentStep": <NEXT_STEP>,
  "completedSteps": [<COMPLETED>],
  "branchName": "<BRANCH>",
  "prNumber": <PR_OR_NULL>,
  "reviewTaskId": "<ID_OR_NULL>",
  "acceptanceTestAttempts": <N>
}
STATEEOF
```

## vibe-admiral 連携判定

```bash
echo "${VIBE_ADMIRAL:-not_set}"
```

- `VIBE_ADMIRAL` が設定されている場合:
  - **Worktree 作成/削除**: スキップ（vibe-admiral が実施済み）
  - **ラベル変更**: スキップ（vibe-admiral が実施済み）
  - **受け入れテスト**: ファイル伝言板方式（後述）
  - **Ship 完了後の後処理**: スキップ（vibe-admiral が実施）
- 設定されていない場合:
  - **Worktree 作成/削除**: スキル内で実行
  - **ラベル変更**: スキル内で実行
  - **受け入れテスト**: AskUserQuestion + open URL を使用

## ワークフロー

### Step 1: GH Issue の特定

リポ情報を取得する:
```bash
REMOTE_URL=$(git remote get-url origin)
REPO=$(echo "$REMOTE_URL" | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')
```

- 引数で指定されている場合:
  ```bash
  gh issue view <番号> --repo "$REPO" --json number,title,labels
  ```
  **重要: `status/investigating` や `status/implementing` 等のアクティブな `status/*` ラベルが付いている場合は「この Issue は既に作業中です。続行しますか？」とユーザーに確認する。**

- 指定がない場合: **必ず `--label status/todo` を指定して** `status/todo` ラベルの Issue のみを取得する:
  ```bash
  gh issue list --repo "$REPO" --label status/todo --state open --json number,title
  ```
  取得した Issue の Sub-issues をチェックして unblocked なものの中から番号が若い順で選択する。
  **`status/todo` 以外の `status/*` ラベルが付いた Issue は絶対に選択しない。**

**`VIBE_ADMIRAL` 未設定の場合のみ**: 選択した Issue のラベルを変更:
```bash
gh issue edit <番号> --repo "$REPO" --remove-label status/todo --add-label status/investigating
```

### Step 2: Worktree 作成

**`VIBE_ADMIRAL` 設定時**: このステップをスキップする（すでに worktree 内にいる）。

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
ISSUE_NUM=<番号>
SHORT_NAME=<kebab-case要約>
BRANCH_NAME="feature/${ISSUE_NUM}-${SHORT_NAME}"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feature/${ISSUE_NUM}-${SHORT_NAME}"

git fetch origin "$DEFAULT_BRANCH"
git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" "origin/${DEFAULT_BRANCH}"

# .claude/settings.local.json をシンボリックリンク
if [ -f "${REPO_ROOT}/.claude/settings.local.json" ]; then
  mkdir -p "${WORKTREE_DIR}/.claude"
  ln -sf "${REPO_ROOT}/.claude/settings.local.json" "${WORKTREE_DIR}/.claude/settings.local.json"
fi

# .worktrees/ を .gitignore に追加（未追加の場合）
if ! grep -q '\.worktrees/' "${REPO_ROOT}/.gitignore" 2>/dev/null; then
  echo '.worktrees/' >> "${REPO_ROOT}/.gitignore"
fi
```

- **Web プロジェクトの場合**: worktree ディレクトリで `npm install` を実行する

worktree 作成後、以降のファイル操作はすべて **worktree ディレクトリ内のパス** を使って行う。

### Step 3: 調査

- Task ツールで並列調査する（影響範囲の特定）
- CLAUDE.md の Conflict Risk Areas を参照する

### Step 4: 計画

**`VIBE_ADMIRAL` 設定時**: EnterPlanMode は使わない（`-p` モードでは ExitPlanMode の承認ができずプロセスが停止するため）。代わりに実装計画をテキストとして出力し、そのまま Step 5 に進む。

**`VIBE_ADMIRAL` 未設定時**:
- EnterPlanMode で実装計画を立てる
- CLAUDE.md の Implementation Layer Order に従って変更レイヤーを分類する
- **plan 確定後、`.claude/plans/` 内のファイルをすべて削除する**

### Step 5: 実装

CLAUDE.md に記載されたレイヤー順序で実装する。

### Step 6: ビルド検証

CLAUDE.md の Commands テーブルに記載されたビルド・テスト・リントコマンドを実行する。
テストやリントが失敗したら修正して再実行する。

### Step 7: 統合

最新のデフォルトブランチをマージし、コンフリクトがあれば解消する。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH" && git merge "origin/$DEFAULT_BRANCH"
```

- コンフリクトが発生したら解消してからコミットする
- **Web プロジェクトの場合**: `npm install` も実行する

### Step 8: テスト再実行

ビルド・テスト・リントを再度実行して統合後の問題がないことを確認する。

### Step 9: コミット & PR

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

   Closes #<Issue 番号>

   ## Test plan
   <ビルド・テスト・リントコマンドの実行結果>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

**PR が既に存在する場合**: 未 push のコミットがあれば `git push` のみ行う。

PR URL をユーザーに報告して Step 10 へ進む。

### Step 10: コードレビュー（CI 並行）

push した時点で CI が走り始める。CI の完了を待たずにコードレビューを実施する。

1. `/review-pr` スキルをバックグラウンドで起動する（Task ツール `run_in_background: true`）
2. Step 11 へ進む

### Step 11: 受け入れテスト

**Native プロジェクトの場合**: このステップをスキップして Step 12 へ進む。

#### VIBE_ADMIRAL 設定時（ファイル伝言板方式）

1. 受け入れテストに到達したら、空きポートを取得してアプリを起動し、`.claude/acceptance-test-request.json` を作成:
   ```bash
   # 空きポートを動的に取得
   PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
   # アプリを起動（run_in_background: true）
   PORT=$PORT npm run dev
   ```
   ```bash
   cat > .claude/acceptance-test-request.json << ATEOF
   {
     "url": "http://localhost:$PORT",
     "checks": [
       "確認ポイント1",
       "確認ポイント2"
     ]
   }
   ATEOF
   ```

2. `.claude/acceptance-test-response.json` の出現を待機:
   ```bash
   echo "Waiting for acceptance test response..."
   while [ ! -f .claude/acceptance-test-response.json ]; do
     sleep 2
   done
   cat .claude/acceptance-test-response.json
   ```

3. レスポンスに基づいて処理:
   - `accepted: true` → アプリ停止 → Step 12 へ
   - `accepted: false` → フィードバックを取得 → 修正 → commit & push → request.json を削除 → response.json を削除 → 再度 request.json を作成して再待機

#### VIBE_ADMIRAL 未設定時

1. 空きポートを動的に取得する:
   ```bash
   PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
   ```
2. アプリを起動する（`run_in_background: true`）:
   ```bash
   PORT=$PORT npm run dev
   ```
3. **`open http://localhost:$PORT` でブラウザを自動で開く**
4. AskUserQuestion で確認依頼する。確認ポイントは変更内容から自動生成する:
   - 変更した UI コンポーネントの表示確認
   - 新機能の動作確認
   - レイアウト崩れがないか
5. OK → アプリ停止 → Step 12 へ
6. NG → フィードバック取得 → 修正 → commit & push → 2回目以降は E2E テスト追加 → `open http://localhost:$PORT` で再度ブラウザを開いて再確認ループ
7. 3回以上 NG → `/second-opinion` を検討

### Step 12: CI パス確認

```bash
PR_NUM=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
gh pr checks "$PR_NUM" --watch
```

- CI が全てパスしたら Step 13 へ
- CI が失敗した場合は Step 16（CI 修正ループ）へ
- **CI が未設定の場合**（`no checks reported` が返る場合）: スキップして Step 13 へ進む

### Step 13: plan ファイルの掃除

- `.claude/plans/` 内に `.md` ファイルが残っていれば削除する（次セッションで古い plan が誤実行されるのを防ぐ）
- **注意**: `~/.claude/plans/` は他プロジェクトの plan が含まれる可能性があるため触らないこと

### Step 14: レビュー結果の対応（マージ前に必須）

**このステップを完了するまで絶対に Step 15 に進んではならない。**
レビュー結果の確認はマージの前提条件である。レビューが未完了の場合は完了を待つこと。

バックグラウンドのレビュー結果を確認する（Read ツールで output_file を確認）。
レビューエージェントがまだ実行中の場合は、完了するまで待機する（output_file を定期的に確認）。

指摘を以下の 3 カテゴリに再分類する:

- **BLOCKER**: 同意する。この PR で修正が必要 → ローカルで修正 → commit & push → Step 12 に戻る（レビューは再実行不要）
- **NICE TO HAVE**: 同意するが別 Issue で対応 → `gh issue create --label status/todo` で別 Issue を作成し、PR コメントで Issue 番号を記録
- **NO NEED**: 同意しない → 対応不要
- **LGTM**: 指摘なし → Step 15 へ

### Step 15: マージ

worktree 環境を前提とする。`--delete-branch` は付けない（`gh` がローカルで `git checkout` を試みて worktree と競合するため）。

```bash
gh pr merge "$PR_NUM" --squash
```

- マージ後に `already used by worktree` エラーが出ても、`gh pr view --json state --jq '.state'` が `MERGED` なら無視してよい

### Step 15.5: 掃除

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
   **重要**: worktree 削除前に必ず `cd "$REPO_ROOT"` でメインリポルートに移動すること。

3. GH Issue を close:
   ```bash
   ISSUE_NUM=$(echo "<branch-name>" | sed -E 's#(feature|refactor)/([0-9]+)-.+#\2#')
   gh issue close "$ISSUE_NUM" --comment "Closed via PR merge"
   ```

4. デプロイ確認: デフォルトブランチへのマージでデプロイ CI が走る場合、完了を待つ:
   ```bash
   DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   RUN_ID=$(gh run list --branch "$DEFAULT_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
   gh run watch $RUN_ID
   ```
   - デプロイ CI が存在しない場合はスキップ

### Step 16: CI 失敗時の修正ループ

1. `gh run view <run-id> --log-failed` で失敗ログを取得する
2. 失敗したテストのエラーを分析する
3. ローカルで修正する（CLAUDE.md の Commands テーブル参照）
4. 修正をコミット & push する
5. Step 12 に戻る

## CI 失敗ログの取得方法

```bash
gh run list --limit=3
gh run view <run-id> --log-failed
```

## 競合リスク

CLAUDE.md の Conflict Risk Areas を参照すること。

## 注意事項

- `.env` は読み書きしない
- 大きな変更は複数回に分けてコミットしてよい
- GH Issue のラベル更新を忘れないこと
- 各ステップで問題が発生したらその場で解決してから次に進む
- ローカルでは関連テストのみ実行し、コンテキスト消費を最小限にする
- 全テストの網羅的な確認は CI に委ねる
- CI 修正ループでは、落ちたテストだけをローカルで実行する
