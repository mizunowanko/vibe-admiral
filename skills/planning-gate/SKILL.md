---
name: planning-gate
description: Plan-review Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /planning-gate — Plan Review Gate (Engine Escort)

Engine が plan-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID`: レビュー対象の Ship ID
- `VIBE_ADMIRAL_MAIN_REPO`: リポジトリ（owner/repo）
- `VIBE_ADMIRAL_ENGINE_PORT`: Engine API ポート（default: 9721）
- `VIBE_ADMIRAL_QA_REQUIRED_PATHS`: qaRequired 強制パス（JSON 配列、未設定時はチェックスキップ）

## Procedure

1. リポ情報を取得:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   QA_REQUIRED_PATHS="${VIBE_ADMIRAL_QA_REQUIRED_PATHS:-}"
   ```

2. Ship の調査ログを確認（コンテキスト理解のため）:
   ```bash
   tail -n 200 .claude/ship-log.jsonl 2>/dev/null | grep '"type":"assistant"' | tail -n 20
   ```

3. Issue の全コンテキストを取得:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body,comments
   ```

4. **Plan 記載チェック（即 reject 判定）**:
   コメント一覧に `## Implementation Plan` ヘッダーを含むコメントが存在するか確認する。
   - 存在しない場合 → **即座に reject して終了**:
     ```bash
     gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "## Plan Review

     **Verdict: REJECT**

     Plan が issue comment に記載されていません。実装計画を \`## Implementation Plan\` セクションとして issue コメントに投稿してから再度 gate に進んでください。"
     ```
     ```bash
     curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
       -H 'Content-Type: application/json' \
       -d '{"verdict": "reject", "feedback": "Plan が issue comment に記載されていません"}'
     ```
     ここで処理を終了する。以降のステップには進まない。
   - 存在する場合 → Step 5 以降の通常レビューフローに進む

5. 全コメントを確認:
   - 前回の plan review 結果（APPROVE/REJECT）があるか確認
   - reject された場合、何が指摘されたか把握

6. 最新の Implementation Plan コメントを読む

6. **qaRequired パスチェック**:

   `QA_REQUIRED_PATHS` が設定されている場合、Implementation Plan の「### Changes」セクションに記載されたファイルパスを `QA_REQUIRED_PATHS` のパターンと突き合わせる。

   - `QA_REQUIRED_PATHS` は JSON 配列（例: `["src/components/**", "src/styles/**"]`）
   - Plan 内の変更ファイル一覧を抽出し、各ファイルがいずれかのパターンに glob マッチするか確認する
   - **マッチするファイルがあり、かつ Plan が `qaRequired: false` と判断している場合** → REJECT する
     - フィードバック例: "qaRequired must be true: planned changes include files matching qaRequiredPaths patterns (e.g., src/components/foo.tsx matches src/components/**). Update the QA Requirement section to qaRequired: true."
   - マッチするファイルがあり Plan が `qaRequired: true` → 問題なし、レビュー続行
   - マッチするファイルがない → 問題なし、レビュー続行
   - `QA_REQUIRED_PATHS` が未設定 → チェックスキップ、レビュー続行


7. レビュー:
   - Plan が Issue の要件を全てカバーしているか
   - 実現可能で適切なスコープか
   - re-review の場合、前回のフィードバックが反映されているか

8. GitHub にレビュー結果を記録:
   ```bash
   gh issue comment <ISSUE_NUMBER> --repo "$REPO" --body "## Plan Review

   <詳細なレビュー>

   ### qaRequired Path Check
   <QA_REQUIRED_PATHS が設定されている場合のみ記載>
   - Configured patterns: <パターン一覧>
   - Planned files matching: <マッチしたファイル一覧 or "none">
   - Plan's qaRequired: <true or false>
   - Check result: <PASS or FAIL (with reason)>

   **Verdict: APPROVE** (or REJECT)"
   ```

9. Engine REST API で gate verdict を送信:

   承認の場合:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}'
   ```

   拒否の場合:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "reject", "feedback": "<修正すべき点>"}'
   ```

## Review Guidelines

- Focus on completeness and feasibility, not style
- For re-reviews: verify previous feedback was addressed. Do NOT repeat same rejection if fixed
- Base decisions on actual plan content, not stale information
- qaRequired path check failure is a **mandatory rejection** — cannot be overridden by reviewer judgment
