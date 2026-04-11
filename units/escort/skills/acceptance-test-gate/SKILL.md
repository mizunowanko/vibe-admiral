---
name: acceptance-test-gate
description: Acceptance-test Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /acceptance-test-gate — Acceptance Test Gate (Engine Escort)

Engine が qa-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID` — この Escort の ID
- `VIBE_ADMIRAL_PARENT_SHIP_ID` — レビュー対象の親 Ship ID
- `VIBE_ADMIRAL_MAIN_REPO` — Fleet のメインリポジトリ（owner/repo）
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API ポート（デフォルト: 9721）
- `VIBE_ADMIRAL_QA_REQUIRED` — QA 要否フラグ（`true` or `false`、未設定時は `true`）
- `VIBE_ADMIRAL_GATE_PROMPT` — Fleet 設定のカスタム gate prompt（未設定時は auto-approve）
- `VIBE_ADMIRAL_QA_REQUIRED_PATHS` — qaRequired 強制パス（JSON 配列、フォールバックチェック用）
- `VIBE_ADMIRAL_ACCEPTANCE_TEST_REQUIRED` — Fleet レベルの受け入れテスト必須フラグ（`false` で即 auto-approve）

## Common: Auto-Approve Helper

以下の auto-approve パスで共通の手順:

1. PR を特定:
   ```bash
   BRANCH_NAME=$(git branch --show-current)
   PR_NUMBER=$(gh pr list --head "$BRANCH_NAME" --repo "$REPO" --json number --jq '.[0].number')
   ```
2. PR が見つかった場合のみコメント投稿（ヘッダー `## Acceptance Test: ⏭️ SKIPPED` or `AUTO-APPROVED`、理由、`🤖 Generated with [Claude Code](https://claude.com/claude-code)` フッター）
3. gate-verdict approve を送信:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}'
   ```
4. **ここで終了する。以降の手順は実行しない。**

## Procedure

### Step 0: 早期リターン判定

```bash
ACCEPTANCE_TEST_REQUIRED="${VIBE_ADMIRAL_ACCEPTANCE_TEST_REQUIRED:-true}"
QA_REQUIRED="${VIBE_ADMIRAL_QA_REQUIRED:-true}"
QA_REQUIRED_PATHS="${VIBE_ADMIRAL_QA_REQUIRED_PATHS:-}"
GATE_PROMPT="${VIBE_ADMIRAL_GATE_PROMPT:-}"
```

以下の順で判定し、該当したら **Auto-Approve Helper** を実行して終了:

1. **`ACCEPTANCE_TEST_REQUIRED=false`** → auto-approve（理由: Fleet setting `acceptanceTestRequired: false`）
2. **`QA_REQUIRED=false`** の場合:
   - `QA_REQUIRED_PATHS` が設定されていれば `git diff --name-only main...HEAD` でパターンマッチ確認
   - マッチするファイルがある → **Step 0a（フォールバック最低限チェック）** へ
   - マッチなし or `QA_REQUIRED_PATHS` 未設定 → auto-approve（理由: `qaRequired: false`, no UI-related changes）
3. **`QA_REQUIRED=true` かつ `GATE_PROMPT` 未設定** → auto-approve（理由: No gate prompt configured）
4. **`QA_REQUIRED=true` かつ `GATE_PROMPT` 設定あり** → **Step 1 以降の完全テストフロー** へ進む

### Step 0a: フォールバック最低限チェック（qaRequired=false + qaRequiredPaths マッチ）

1. PR を特定し、`git diff main...HEAD` で変更内容を確認
2. UI 表示に影響する明らかなリグレッションがないかチェック:
   - 表示値の変更が意図通りか、CSS/スタイル変更がレイアウトを壊していないか、props/型の互換性
   - UI 関連ファイルが含まれる場合は **Step 2.5（UI 表示整合性チェック）** も実施
3. PR コメント投稿（ヘッダー `## Acceptance Test: 🔍 MINIMAL CHECK`、マッチファイル一覧、チェック結果、Verdict）
4. gate-verdict を送信（approve or reject。reject 時のみ構造化 `feedback` 付与）
5. **ここで終了する。**

---

以下は **`QA_REQUIRED=true` かつ `GATE_PROMPT` 設定あり** の場合のみ実行する。

---

### Step 1: セットアップ

セットアップ:
   ```bash
   PARENT_SHIP_ID="${VIBE_ADMIRAL_PARENT_SHIP_ID}"
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   ```

1. PR を特定（見つからなければ reject + feedback "PR not found"）
2. Issue の全コンテキストを取得し、受け入れ基準と Implementation Plan のテスト方針を把握:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body,comments
   ```

### Step 2: Gate Prompt に従ってテストを実行

**`VIBE_ADMIRAL_GATE_PROMPT` の内容をテスト手順として実行する。**
Gate prompt にはプロジェクト固有のテスト手順が記述されている（例: Playwright E2E、CLI テスト、API テストなど）。

### Step 2.5: UI 表示整合性チェック（UI 関連変更がある場合は必須）

PR diff に `src/components/` 配下、表示値リネーム、`STATUS_CONFIG`、バッジ定義、Store 構造変更のいずれかが含まれる場合に実施:

1. **レンダリング箇所の特定**: 変更コンポーネントが使用される全画面・パネルを確認
2. **表示値のソース追跡**: Frontend → Engine → DB/型定義の全レイヤーで値が一貫しているか確認
3. **関連コンポーネントの横断確認**: 同じ値を表示する全コンポーネント（カード、詳細パネル、バッジ、リスト等）で正しく表示されるか確認

> リネーム漏れが 1 箇所でもあれば FAIL とする。

### Step 3: テスト結果を判定

- 全テスト合格か、失敗項目ありかを判定
- Issue の受け入れ基準の各項目について充足度を評価

### Step 4: Gate intent → verdict → GitHub 記録

Gate API は親 Ship（`PARENT_SHIP_ID`）に対して実行する。`SHIP_ID`（Escort 自身）ではない。

**4a. Gate intent（verdict 前のフォールバック）**:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-intent \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "<approve or reject>"}'
```

**4b. Gate verdict（GitHub コメントより先に実行）**:

承認:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "approve"}'
```

拒否（構造化フィードバック付き — ADR-0018）:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{
    "verdict": "reject",
    "feedback": {
      "summary": "<1-2文の要約>",
      "items": [
        {
          "category": "<plan|code|test|style|security|performance>",
          "severity": "<blocker|warning|suggestion>",
          "message": "<具体的な指摘内容>"
        }
      ]
    }
  }'
```

> `blocker` は修正必須、`warning` は推奨、`suggestion` は任意。

### Step 5: 結果を PR コメントとして書き込む（verdict 送信後に実行）

```markdown
## Acceptance Test Result: ✅ PASS / ❌ FAIL

### テスト項目
- [x] テスト項目 1
- [ ] テスト項目 2（fail の場合）

<details><summary>検証ログ</summary>
検証内容と結果の詳細（テストファイル、出力サマリ、受け入れ基準との対応）
</details>

### 判定
**APPROVE** / **REQUEST CHANGES** — 判定理由

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

> 1 つでも fail があれば `❌ FAIL` とする。

## Test Guidelines

- All existing tests must pass. No tests yet → approve
- Flaky test failures: re-run once before rejecting
- 受け入れ基準が明示されていない場合は Issue タイトル・本文から暗黙の基準を推定
- Re-tests: 前回 fail した項目の修正確認を重点的に実施
