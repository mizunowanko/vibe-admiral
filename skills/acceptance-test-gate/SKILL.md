---
name: acceptance-test-gate
description: Acceptance-test Gate の Escort 実行手順。Escort sub-agent が自動起動時に使用
user-invocable: true
---

# /acceptance-test-gate — Acceptance Test Gate (Engine Escort)

Engine が qa-gate フェーズを検知したとき、独立プロセス（`claude -p`）として起動される Escort skill。
Fleet の `gatePrompts` 設定に基づいてプロジェクト固有の受け入れテストを実行し、結果を PR コメントに書き込む。

## 引数

- Issue 番号（例: `42`）

## 環境変数

- `VIBE_ADMIRAL_SHIP_ID`: テスト対象の Ship ID
- `VIBE_ADMIRAL_MAIN_REPO`: リポジトリ（owner/repo）
- `VIBE_ADMIRAL_ENGINE_PORT`: Engine API ポート（default: 9721）
- `VIBE_ADMIRAL_QA_REQUIRED`: QA 要否フラグ（`true` or `false`、未設定時は `true` として扱う）
- `VIBE_ADMIRAL_GATE_PROMPT`: Fleet 設定のカスタム gate prompt（未設定時は auto-approve）

## Procedure

### Step 0: QA 要否チェック（早期リターン）

```bash
QA_REQUIRED="${VIBE_ADMIRAL_QA_REQUIRED:-true}"
```

`QA_REQUIRED` が `false` の場合:

1. PR を特定:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   BRANCH_NAME=$(git branch --show-current)
   PR_NUMBER=$(gh pr list --head "$BRANCH_NAME" --repo "$REPO" --json number --jq '.[0].number')
   ```

2. **UI 変更フォールバックチェック**: `qaRequired: false` であっても、以下に該当する場合は **最低限の UI 表示確認** を実施する:
   ```bash
   # PR の diff に UI 関連ファイルの変更があるか確認
   UI_CHANGES=$(gh pr diff "$PR_NUMBER" --repo "$REPO" --name-only 2>/dev/null | grep -E '^src/components/|STATUS_CONFIG|phase|badge|card' || true)
   ```
   - `UI_CHANGES` が空でない場合 → **Step 3.5（UI 表示整合性チェック）を実施してから approve する**。コメントには確認した UI 項目を記載する
   - `UI_CHANGES` が空の場合 → 従来通り即 approve

   **UI 変更なしの場合**: QA スキップコメントを投稿して即 approve:
   ```bash
   gh pr comment "$PR_NUMBER" --repo "$REPO" --body "## Acceptance Test: ⏭️ SKIPPED

   QA not required for this change (\`qaRequired: false\`).
   No UI-related file changes detected.
   Automatically approved by acceptance-test-gate.

   🤖 Generated with [Claude Code](https://claude.com/claude-code)"
   ```

   **UI 変更ありの場合**: Step 3.5 の UI 表示整合性チェックを実施した後、結果をコメントに含めて approve:
   ```bash
   gh pr comment "$PR_NUMBER" --repo "$REPO" --body "## Acceptance Test: ⏭️ SKIPPED (with UI verification)

   QA not required (\`qaRequired: false\`), but UI-related changes detected.
   Performed minimum UI integrity check:

   <UI 表示整合性チェックの結果をここに記載>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)"
   ```

3. gate-verdict approve を送信:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}'
   ```

4. **ここで終了する。以降の手順は実行しない。**

`QA_REQUIRED` が `true` の場合、以降の手順に進む。

---

### Step 1: Gate Prompt チェック

```bash
GATE_PROMPT="${VIBE_ADMIRAL_GATE_PROMPT:-}"
```

**`GATE_PROMPT` が未設定の場合**: Fleet に受け入れテストの手順が設定されていない。auto-approve として扱う:

1. PR を特定してコメントを投稿:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   BRANCH_NAME=$(git branch --show-current)
   PR_NUMBER=$(gh pr list --head "$BRANCH_NAME" --repo "$REPO" --json number --jq '.[0].number')
   ```

   PR が見つかった場合のみコメントを投稿:
   ```bash
   gh pr comment "$PR_NUMBER" --repo "$REPO" --body "## Acceptance Test: ⏭️ AUTO-APPROVED

   No gate prompt configured in Fleet settings for this gate type.
   Automatically approved by acceptance-test-gate.

   🤖 Generated with [Claude Code](https://claude.com/claude-code)"
   ```

2. gate-verdict approve を送信:
   ```bash
   curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}'
   ```

3. **ここで終了する。以降の手順は実行しない。**

**`GATE_PROMPT` が設定されている場合**: 以降の手順に進む。

---

### Step 2: 共通セットアップ

1. リポ情報を取得:
   ```bash
   REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
   SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
   ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
   BRANCH_NAME=$(git branch --show-current)
   ```

2. PR を特定:
   ```bash
   PR_JSON=$(gh pr list --head "$BRANCH_NAME" --repo "$REPO" --json number,url --jq '.[0]')
   ```
   PR が見つからない場合は、gate を reject して feedback "PR not found" を書き込む。

3. Issue の全コンテキストを取得:
   ```bash
   gh issue view <ISSUE_NUMBER> --repo "$REPO" --json title,body,comments
   ```
   - Issue 本文の「受け入れ基準」セクションを特定する
   - Implementation Plan コメントからテスト方針を把握する

### Step 3: Gate Prompt に従ってテストを実行

**`VIBE_ADMIRAL_GATE_PROMPT` の内容をテスト手順として実行する。**

Gate prompt にはプロジェクト固有のテスト手順が記述されている（例: Playwright E2E、CLI テスト、API テストなど）。
その手順に従ってテストを実行し、結果を収集する。

### Step 3.5: UI 表示整合性チェック（UI 関連変更がある場合は必須）

PR の diff に以下のいずれかが含まれる場合、このステップは **必須** で実行する:
- `src/components/` 配下のファイル変更
- 表示値（phase 名、ステータス、ラベル等）のリネーム・変更
- `STATUS_CONFIG`、表示ヘルパー関数、バッジ定義の変更
- Store（Zustand）の状態構造変更

```bash
# PR の diff からUI関連ファイルを検出
UI_FILES=$(gh pr diff "$PR_NUMBER" --repo "$REPO" --name-only 2>/dev/null | grep -E '^src/components/|STATUS_CONFIG|phase|badge|card|store' || true)
```

UI 関連変更が **ない** 場合はこのステップをスキップしてよい。

#### 3.5a. レンダリング画面の特定

変更されたコンポーネントが **実際にレンダリングされる全ての画面・箇所** を特定する:
- どのページ・パネルで使用されているか
- 親コンポーネントからどのように呼び出されているか
- 条件付きレンダリング（if/switch）がある場合、全ブランチを確認

#### 3.5b. 表示値のソース追跡

変更された表示値について、データフローを **末端から源泉まで** 追跡する:
1. **Frontend**: コンポーネントの props / store selector / computed 値を確認
2. **Engine**: WebSocket メッセージや REST API レスポンスで渡される値を確認
3. **DB / 型定義**: `engine/src/types.ts` や共通型の定義と一致するか確認

> **重要**: phase 名のような「DB → Engine → Frontend」を貫通する値は、**全レイヤーの型定義が一貫している** ことを確認する。1 箇所でもリネーム漏れがあれば FAIL とする。

#### 3.5c. 関連コンポーネントの横断確認

同じ値を表示する **全てのコンポーネント** で正しく表示されることを確認する:
- Ship カード（一覧表示）
- Ship 詳細パネル
- バッジ・ステータス表示
- リスト・テーブル表示
- ツールチップやポップオーバー

> **失敗事例（PR #641）**: phase 名のリネームで一部のコンポーネント（バッジ表示）の更新が漏れ、`qaRequired: false` で承認されてしまった。この横断確認で検出できるケース。

### Step 4: テスト結果を判定

- テスト成功 → 全テスト合格
- テスト失敗 → 失敗項目あり
- Issue の受け入れ基準の各項目について、テスト結果と diff の内容から充足度を評価する

### Step 5: 結果を PR コメントとして書き込む

以下のフォーマットで PR コメントを投稿する:
```bash
gh pr comment <PR_NUMBER> --repo "$REPO" --body "<formatted result>"
```

コメントのフォーマット:
```markdown
## Acceptance Test Result: ✅ PASS / ❌ FAIL

### テスト項目
- [x] テスト項目 1（pass の場合）
- [x] テスト項目 2（pass の場合）
- [ ] テスト項目 3（fail の場合）

### 詳細
<details>
<summary>検証ログ</summary>

各テスト項目の検証内容と結果の詳細をここに記載する。
- どのテストファイル・テストケースを確認したか
- テスト実行の出力サマリ
- Issue 受け入れ基準との対応関係
- fail の場合は具体的な不足点

</details>

### 判定
**APPROVE** / **REQUEST CHANGES** — 判定理由の説明

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

> **重要**: ヘッダーの `✅ PASS` / `❌ FAIL` は全テスト項目の結果に基づいて決定する。
> 1 つでも fail があれば `❌ FAIL` とする。

### Step 6: Gate verdict を送信

承認の場合（全テスト項目 pass）:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "approve"}'
```

拒否の場合（1 つ以上の項目が fail）:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "reject", "feedback": "<fail した項目と修正すべき点の要約>"}'
```

## Test Guidelines

- All existing tests must pass
- If no tests exist yet, approve (test coverage is tracked separately)
- Flaky test failures: re-run once before rejecting
- 受け入れ基準が明示されていない場合は、Issue タイトルと本文から暗黙の基準を推定する
- For re-tests: 前回 fail した項目が修正されているかを重点的に確認する。修正済みなら pass に切り替える
