# /gate-plan-review — Plan Review Gate (Engine Escort)

Engine が plan-review gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID`: レビュー対象の Ship ID
- `VIBE_ADMIRAL_DB_PATH`: Fleet SQLite データベースパス
- `VIBE_ADMIRAL_MAIN_REPO`: リポジトリ（owner/repo）

## Procedure

1. リポ情報を取得:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   DB_PATH="$VIBE_ADMIRAL_DB_PATH"
   ```

2. Ship の調査ログを確認（コンテキスト理解のため）:
   ```bash
   tail -n 200 .claude/ship-log.jsonl 2>/dev/null | grep '"type":"assistant"' | tail -n 20
   ```

3. Issue の全コンテキストを取得:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body,comments
   ```

4. 全コメントを確認:
   - 前回の plan review 結果（APPROVE/REJECT）があるか確認
   - reject された場合、何が指摘されたか把握

5. 最新の Implementation Plan コメントを読む

6. レビュー:
   - Plan が Issue の要件を全てカバーしているか
   - 実現可能で適切なスコープか
   - re-review の場合、前回のフィードバックが反映されているか

7. GitHub にレビュー結果を記録:
   ```bash
   gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "## Plan Review

   <詳細なレビュー>

   **Verdict: APPROVE** (or REJECT)"
   ```

8. DB の phases テーブルを直接更新:

   承認の場合:
   ```bash
   sqlite3 "$DB_PATH" "
   BEGIN;
     UPDATE phases SET phase = 'implementing', updated_at = datetime('now')
       WHERE ship_id = '$SHIP_ID' AND phase = 'planning-gate';
     INSERT INTO phase_transitions (ship_id, from_phase, to_phase, metadata)
       VALUES ('$SHIP_ID', 'planning-gate', 'implementing', '{\"gate_result\": \"approved\"}');
   COMMIT;
   "
   ```

   拒否の場合:
   ```bash
   sqlite3 "$DB_PATH" "
   BEGIN;
     UPDATE phases SET phase = 'planning', updated_at = datetime('now')
       WHERE ship_id = '$SHIP_ID' AND phase = 'planning-gate';
     INSERT INTO phase_transitions (ship_id, from_phase, to_phase, metadata)
       VALUES ('$SHIP_ID', 'planning-gate', 'planning',
         '{\"gate_result\": \"rejected\", \"feedback\": \"<修正すべき点>\"}');
   COMMIT;
   "
   ```

## Review Guidelines

- Focus on completeness and feasibility, not style
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- Base decisions on actual plan content, not stale information
