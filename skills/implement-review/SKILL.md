---
name: implement-review
description: /implement のサブスキル — コードレビュー準備
user-invocable: false
---

# /implement-review — Commit, PR & Code Review

> **CRITICAL: Step 1 → Step 2 の順序は絶対にスキップ・逆転してはならない。**
> code-review Gate が承認されてから次の sub-skill に進む。

## Step 1: コミット & PR 作成

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

**PR が既に存在する場合**: 未 push のコミットがあれば `git push` のみ。

PR URL をユーザーに報告する。

## Step 2: code-review Gate

> **このステップで code-review Gate が承認されるまで、次の sub-skill (`/implement-merge`) に進んではならない。**

### VIBE_ADMIRAL 設定時（Ship Escort 方式）

PR 作成/push 完了後、Engine REST API で `coding-gate` に遷移し、**code-review Gate** を開始する:

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition \
  -H 'Content-Type: application/json' \
  -d '{"phase": "coding-gate", "metadata": {}}'
```

Engine が Escort プロセスを起動して code-review を実施する。ポーリングして phase 変更を検知（タイムアウト付き単一コマンド）。
**NOTE: ループ内の `sleep 60` は意図的なポーリング間隔であり、rate limit backoff ではない。遅延があっても rate limit と誤認しないこと。**

```bash
TIMEOUT=900; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do RESULT=$(curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase); PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4); case "$PHASE" in qa) echo "Gate approved"; break ;; coding) echo "Gate rejected"; break ;; coding-gate) sleep 60 ;; *) echo "UNEXPECTED_PHASE: $PHASE"; break ;; esac; ELAPSED=$((ELAPSED + 60)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `qa` に遷移済み → Escort が承認。`/implement-merge` に進む
- `coding` に戻された → Escort が reject した。phase-transition-log API からフィードバックを取得し、PR レビューコメントを確認して修正 → commit & push → 再度 gate に遷移 → Engine が Escort を再起動:
  ```bash
  # 構造化フィードバックを取得（ADR-0018: summary + items[]）
  TRANSITION_JSON=$(curl -sf "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition-log?limit=1")
  # summary を抽出
  FEEDBACK_SUMMARY=$(echo "$TRANSITION_JSON" | grep -o '"summary":"[^"]*"' | head -1 | cut -d'"' -f4)
  # items の message と file/line を抽出（code-review は file/line 付き）
  FEEDBACK_ITEMS=$(echo "$TRANSITION_JSON" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
  FEEDBACK_FILES=$(echo "$TRANSITION_JSON" | grep -o '"file":"[^"]*"' | cut -d'"' -f4)
  # フォールバック: 旧形式（string feedback）
  if [ -z "$FEEDBACK_SUMMARY" ]; then
    FEEDBACK_SUMMARY=$(echo "$TRANSITION_JSON" | grep -o '"feedback":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi
  ```
  取得したフィードバックの `summary` と各 `items[].message` を確認し、`file` / `line` で指摘箇所を特定して修正する。`severity: blocker` の項目は必ず対応すること。

### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動（Task ツール `run_in_background: true`）
2. `/implement-merge` に進む（レビュー結果は `/implement-merge` Step 4 で対応）

## 完了後

workflow-state.json を更新して `/implement-merge` に進む。
