---
name: implement-setup
description: /implement のサブスキル — worktree + ブランチ初期化
user-invocable: false
---

# /implement-setup — Issue Identification & Worktree Setup

## 引数

- Issue 番号（例: `#42`, `42`）または Issue タイトルの一部（省略可）

## vibe-admiral 連携判定

```bash
if [ "${VIBE_ADMIRAL}" = "true" ]; then echo "VIBE_ADMIRAL_ENABLED"; else echo "VIBE_ADMIRAL_DISABLED"; fi
```

## Step 1: GH Issue の特定

リポ情報を取得する:
```bash
REMOTE_URL=$(git remote get-url origin)
REPO=$(echo "$REMOTE_URL" | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')
```

**`VIBE_ADMIRAL` 設定時**: Engine が sortie 時に issue 情報を `--append-system-prompt` 経由で `[Issue Context]` ブロックとして注入済み。`gh issue view` は呼ばず、prompt に含まれた issue 情報を使用する。

**`VIBE_ADMIRAL` 未設定時**:
- 引数で指定されている場合:
  ```bash
  gh issue view <番号> --repo "$REPO" --json number,title,body,labels,comments
  ```
  **重要: `status/` prefix のアクティブラベル（`status/todo` 以外）が付いている場合は「この Issue は既に作業中です。続行しますか？」とユーザーに確認する。**

- 指定がない場合: **必ず `--label status/todo` を指定して**取得:
  ```bash
  gh issue list --repo "$REPO" --label status/todo --state open --json number,title
  ```
  Sub-issues をチェックして unblocked なものの中から番号が若い順で選択する。
  **アクティブステータスラベルが付いている Issue は絶対に選択しない。**

- ラベル変更:
  ```bash
  gh issue edit <番号> --repo "$REPO" --remove-label status/todo --add-label status/implementing
  ```

## Step 2: Worktree 作成

**`VIBE_ADMIRAL` 設定時**: スキップ（すでに worktree 内にいる）。

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

worktree 作成後、以降のファイル操作はすべて **worktree ディレクトリ内のパス** を使う。

## 完了後

workflow-state.json を更新して `/implement-plan` に進む。
