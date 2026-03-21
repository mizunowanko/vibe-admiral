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

Escort が完了すると、DB に `gate-response` が書き込まれる。ポーリングして結果を取得（タイムアウト付き単一コマンド）:

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"; SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"; TIMEOUT=600; ELAPSED=0; while [ $ELAPSED -lt $TIMEOUT ]; do ROW=$(sqlite3 "$DB_PATH" "SELECT payload FROM messages WHERE ship_id='$SHIP_ID' AND type='gate-response' AND read_at IS NULL LIMIT 1" 2>/dev/null); if [ -n "$ROW" ]; then sqlite3 "$DB_PATH" "UPDATE messages SET read_at=datetime('now') WHERE ship_id='$SHIP_ID' AND type='gate-response' AND read_at IS NULL"; echo "$ROW"; break; fi; sleep 3; ELAPSED=$((ELAPSED + 3)); done; [ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

- `approved: true` → `acceptance-test` に直接 DB 更新して遷移、`/implement-merge` に進む
- `approved: false` → PR レビューコメントを確認し修正 → commit & push → 再度 gate に遷移 → Escort 起動ループ

#### Gate 承認後の遷移

Gate 承認後、`acceptance-test` に直接 DB 更新:

```bash
sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
BEGIN;
  UPDATE phases SET phase = 'acceptance-test', updated_at = datetime('now')
    WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID';
  UPDATE ships SET phase = 'acceptance-test'
    WHERE id = '$VIBE_ADMIRAL_SHIP_ID' AND phase = 'implementing-gate';
  INSERT INTO phase_transitions (ship_id, from_phase, to_phase, triggered_by, metadata)
    VALUES ('$VIBE_ADMIRAL_SHIP_ID', 'implementing-gate', 'acceptance-test', 'ship', '{}');
COMMIT;
"
```

### VIBE_ADMIRAL 未設定時

1. `/review-pr` スキルをバックグラウンドで起動（Task ツール `run_in_background: true`）
2. `/implement-merge` に進む（レビュー結果は `/implement-merge` Step 4 で対応）

## 完了後

workflow-state.json を更新して `/implement-merge` に進む。
