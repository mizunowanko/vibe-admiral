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

## ステータス遷移（admiral-request プロトコル）

**`VIBE_ADMIRAL` 設定時のみ有効。**
Ship はステータス遷移を admiral-request ブロックで Engine に表明する。
Engine は GitHub ラベル更新に成功した場合のみ遷移を確定し、結果を `.claude/admiral-request-response.json` に書き込む。

### 遷移の表明手順

**各ステップの冒頭で**、以下のコードブロックを assistant テキストとして出力する:

````
```admiral-request
{ "request": "status-transition", "status": "<phase-name>" }
```
````

**`implementing` への遷移時のみ**: 計画を Issue コメントに投稿済みの場合、`planCommentUrl` を含める:

````
```admiral-request
{ "request": "status-transition", "status": "implementing", "planCommentUrl": "<comment-url>" }
```
````

出力後、Engine からのレスポンスを確認する:

```bash
# Wait for Engine response
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
RESPONSE=$(cat .claude/admiral-request-response.json)
rm -f .claude/admiral-request-response.json
echo "$RESPONSE"
```

- `ok: true` → 遷移確定、次の作業に進む
- `ok: false` (Gate なし) → `error` フィールドを確認して対処
- `ok: false` + `error` に "Gate check initiated" を含む → Gate 待機フローに入る

### Gate 待機フロー

特定のステータス遷移には Gate（関門）が設定されている。Gate 付き遷移を表明した場合、
Engine は `ok: false` を返し、Bridge sub-agent が品質チェックを実施する。
Ship は `.claude/gate-response.json` の出現を待機する:

```bash
echo "Gate check initiated. Waiting for Bridge approval..."
rm -f .claude/admiral-request-response.json
while [ ! -f .claude/gate-response.json ]; do
  sleep 2
done
GATE_RESULT=$(cat .claude/gate-response.json)
rm -f .claude/gate-response.json
rm -f .claude/gate-request.json
echo "$GATE_RESULT"
```

- `approved: true` → Gate 承認。Engine が自動でステータスを確定する。次の作業に進む
- `approved: false` → Gate 拒否。Bridge のフィードバックは GitHub に記録されている:
  - **plan-review 拒否**: Issue コメントにレビュー結果が投稿されている。`gh issue view <number> --repo "$REPO" --json comments` で最新コメントを確認する
  - **code-review 拒否**: PR レビューコメントに指摘が投稿されている。`gh pr view <pr-number> --repo "$REPO" --json reviews,comments` で確認する
  - フィードバックに基づいて修正し、再度 `status-transition` を表明する

### Gate 付き遷移の一覧

| 遷移 | Gate タイプ | 内容 |
|------|-----------|------|
| `planning → implementing` | plan-review | Bridge が計画の妥当性を検証 |
| `testing → reviewing` | code-review | Bridge が PR の品質を検証 |
| `reviewing → acceptance-test` | playwright | Bridge が自動 QA を実施 |
| `acceptance-test → merging` | human | 人間が UI で承認 |

### ステップ対応表

| Step | ステータス (`status`) |
|------|---------------------|
| 3 (調査) | `investigating` |
| 4 (計画) | `planning` |
| 5 (実装) | `implementing` |
| 6 (ビルド検証) | `testing` |
| 8 (テスト再実行) | (testing 継続、遷移表明なし) |
| 9 (コミット & PR) | `reviewing` (PR 作成後に遷移) |
| 11 (受け入れテスト) | `acceptance-test` |
| 15 (マージ) | `merging` |
| 15.5 (完了) | `done` |

### `VIBE_ADMIRAL` 未設定時

admiral-request ブロックは不要。フェーズ宣言もスキップしてよい。

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
  **重要: `status/` prefix のアクティブラベル（`status/todo` 以外）が付いている場合は「この Issue は既に作業中です。続行しますか？」とユーザーに確認する。**

- 指定がない場合: **必ず `--label status/todo` を指定して** `status/todo` ラベルの Issue のみを取得する:
  ```bash
  gh issue list --repo "$REPO" --label status/todo --state open --json number,title
  ```
  取得した Issue の Sub-issues をチェックして unblocked なものの中から番号が若い順で選択する。
  **アクティブステータスラベルが付いている Issue は絶対に選択しない。**

**`VIBE_ADMIRAL` 未設定の場合のみ**: 選択した Issue のラベルを変更:
```bash
gh issue edit <番号> --repo "$REPO" --remove-label status/todo --add-label status/implementing
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

**`VIBE_ADMIRAL` 設定時**: EnterPlanMode は使わない（`-p` モードでは ExitPlanMode の承認ができずプロセスが停止するため）。代わりに:

1. 実装計画をテキストとして作成する（変更対象ファイル、実装方針、影響範囲、テスト方針を含む）
2. **計画を Issue コメントとして投稿する**:
   ```bash
   PLAN_COMMENT_URL=$(gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "$(cat <<'PLANEOF'
   ## Implementation Plan

   ### Changes
   <変更対象ファイル一覧>

   ### Approach
   <実装方針の要約>

   ### Impact Analysis
   <影響範囲の分析>

   ### Test Plan
   <テスト方針>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   PLANEOF
   )")
   echo "$PLAN_COMMENT_URL"
   ```
3. `implementing` への status-transition に `planCommentUrl` を含めて遷移を表明する

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

   Ref #<Issue 番号>

   ## Test plan
   <ビルド・テスト・リントコマンドの実行結果>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

**PR が既に存在する場合**: 未 push のコミットがあれば `git push` のみ行う。

PR URL をユーザーに報告する。

PR 作成後、`reviewing` への遷移を表明する。この遷移は `testing → reviewing` の code-review Gate をトリガーする:

````
```admiral-request
{ "request": "status-transition", "status": "reviewing" }
```
````

```bash
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
RESPONSE=$(cat .claude/admiral-request-response.json)
rm -f .claude/admiral-request-response.json
echo "$RESPONSE"
```

Gate が発動した場合は Gate 待機フローに従う。Step 10 へ進む。

### Step 10: コードレビュー（CI 並行）

push した時点で CI が走り始める。CI の完了を待たずにコードレビューを実施する。

#### VIBE_ADMIRAL 設定時（Gate 方式）

Step 9 で `testing → reviewing` の遷移を表明した際に code-review Gate が発動し、Bridge が自動的に PR のコードレビューを実施する。
Ship は Gate 待機フロー（前述）に従い、`gate-response.json` を待機する。

- `approved: true` → Step 11 へ進む
- `approved: false` → Bridge のフィードバックは PR レビューコメントに記録されている。`gh pr view <pr-number> --repo "$REPO" --json reviews,comments` で確認し、修正 → commit & push → 再度 `status-transition` で `reviewing` を表明

#### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動する（Task ツール `run_in_background: true`）
2. Step 11 へ進む

### Step 11: 受け入れテスト

#### VIBE_ADMIRAL 設定時（ファイル伝言板方式）

まず `acceptance-test` への遷移を表明する。この遷移は `reviewing → acceptance-test` の playwright Gate をトリガーする:

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

Gate が発動した場合は Gate 待機フローに従い、Bridge による自動 QA の完了を待つ。
Gate 承認後、受け入れテストのファイル伝言板フローに進む。

1. 受け入れテストに到達したら、空きポートを取得してアプリを起動する。**アプリが実際に listen 状態になるまで待機してから** `.claude/acceptance-test-request.json` を作成する:
   ```bash
   # 空きポートを動的に取得
   PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
   # アプリを起動（run_in_background: true）
   PORT=$PORT npm run dev
   ```
   ```bash
   # dev server が実際にポートを listen するまで待機（30秒タイムアウト）
   echo "Waiting for dev server to start on port $PORT..."
   for i in $(seq 1 30); do
     if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT" 2>/dev/null | grep -qE '^[1-9]'; then
       echo "Dev server is ready on port $PORT"
       break
     fi
     if [ $i -eq 30 ]; then
       echo "WARNING: Dev server did not start within 30s on port $PORT"
     fi
     sleep 1
   done
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
3. dev server が実際にポートを listen するまで待機する:
   ```bash
   echo "Waiting for dev server to start on port $PORT..."
   for i in $(seq 1 30); do
     if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT" 2>/dev/null | grep -qE '^[1-9]'; then
       echo "Dev server is ready on port $PORT"
       break
     fi
     if [ $i -eq 30 ]; then
       echo "WARNING: Dev server did not start within 30s on port $PORT"
     fi
     sleep 1
   done
   ```
4. **`open http://localhost:$PORT` でブラウザを自動で開く**
5. AskUserQuestion で確認依頼する。確認ポイントは変更内容から自動生成する:
   - 変更した UI コンポーネントの表示確認
   - 新機能の動作確認
   - レイアウト崩れがないか
6. OK → アプリ停止 → Step 12 へ
7. NG → フィードバック取得 → 修正 → commit & push → 2回目以降は E2E テスト追加 → `open http://localhost:$PORT` で再度ブラウザを開いて再確認ループ
8. 3回以上 NG → `/second-opinion` を検討

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

#### VIBE_ADMIRAL 設定時（Gate 方式）

Step 10 で code-review Gate の approve/reject 対応が完了しているため、そのまま Step 15 へ進む。

#### VIBE_ADMIRAL 未設定時

バックグラウンドのレビュー結果を確認する（Read ツールで output_file を確認）。
レビューエージェントがまだ実行中の場合は、完了するまで待機する（output_file を定期的に確認）。

指摘を以下の 3 カテゴリに再分類する:

- **BLOCKER**: 同意する。この PR で修正が必要 → ローカルで修正 → commit & push → Step 12 に戻る（レビューは再実行不要）
- **NICE TO HAVE**: 同意するが別 Issue で対応 → `gh issue create --label status/todo` で別 Issue を作成し、PR コメントで Issue 番号を記録
- **NO NEED**: 同意しない → 対応不要
- **LGTM**: 指摘なし → Step 15 へ

### Step 15: マージ

まず `merging` への遷移を表明する。この遷移は `acceptance-test → merging` の human Gate をトリガーする:

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

Gate が発動した場合は Gate 待機フローに従い、人間の UI 承認を待つ。Gate 承認後、マージを実行する。

worktree 環境を前提とする。`--delete-branch` は付けない（`gh` がローカルで `git checkout` を試みて worktree と競合するため）。

```bash
gh pr merge "$PR_NUM" --squash
```

- マージ後に `already used by worktree` エラーが出ても、`gh pr view --json state --jq '.state'` が `MERGED` なら無視してよい

### Step 15.5: 完了表明と掃除

**`VIBE_ADMIRAL` 設定時**: まず `done` ステータスを表明する:

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
- GH Issue のラベル更新を忘れないこと（VIBE_ADMIRAL 未設定時のみ。設定時は Engine が管理）
- 各ステップで問題が発生したらその場で解決してから次に進む
- ローカルでは関連テストのみ実行し、コンテキスト消費を最小限にする
- 全テストの網羅的な確認は CI に委ねる
- CI 修正ループでは、落ちたテストだけをローカルで実行する
