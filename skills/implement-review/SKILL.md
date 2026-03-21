# /implement-review — Commit, PR & Code Review (Steps 9-10)

> **CRITICAL: Step 9 → Step 10 の順序は絶対にスキップ・逆転してはならない。**
> code-review Gate が承認されてから次の sub-skill に進む。

## Step 9: コミット & PR 作成

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

## Step 10: code-review Gate

> **このステップで code-review Gate が承認されるまで、次の sub-skill (`/implement-merge`) に進んではならない。**

### VIBE_ADMIRAL 設定時（Ship Escort 方式）

PR 作成/push 完了後、`implementing-gate` に直接 DB 更新で遷移し、**code-review Gate** を開始する:

```bash
sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
BEGIN;
  UPDATE phases SET phase = 'implementing-gate', updated_at = datetime('now')
    WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID';
  UPDATE ships SET phase = 'implementing-gate'
    WHERE id = '$VIBE_ADMIRAL_SHIP_ID' AND phase = 'implementing';
  INSERT INTO phase_transitions (ship_id, from_phase, to_phase, triggered_by, metadata)
    VALUES ('$VIBE_ADMIRAL_SHIP_ID', 'implementing', 'implementing-gate', 'ship', '{}');
COMMIT;
"
```

Ship 自身が Escort (sub-agent) を起動して code-review を実施する。`/gate-code-review` スキルを参照して Escort を Task tool で起動する。

Escort が完了すると、DB の `phases` テーブルが直接更新される。ポーリングして phase 変更を検知（タイムアウト付き単一コマンド）:

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"; SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"; TIMEOUT=600; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do PHASE=$(sqlite3 "$DB_PATH" "SELECT phase FROM phases WHERE ship_id='$SHIP_ID'" 2>/dev/null); case "$PHASE" in acceptance-test) echo "Gate approved"; break ;; implementing) echo "Gate rejected"; break ;; implementing-gate) sleep 3 ;; *) echo "UNEXPECTED_PHASE: $PHASE"; break ;; esac; ELAPSED=$((ELAPSED + 3)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `acceptance-test` に遷移済み → Escort が承認し phase を更新済み。`/implement-merge` に進む
- `implementing` に戻された → Escort が reject した。`phase_transitions` からフィードバックを取得し、PR レビューコメントを確認して修正 → commit & push → 再度 gate に遷移 → Escort 起動ループ:
  ```bash
  FEEDBACK=$(sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
    SELECT json_extract(metadata, '$.feedback')
    FROM phase_transitions
    WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID'
    ORDER BY created_at DESC LIMIT 1
  ")
  ```

### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動（Task ツール `run_in_background: true`）
2. `/implement-merge` に進む（レビュー結果は Step 14 で対応）

## 完了後

workflow-state.json を更新して `/implement-merge` に進む。
