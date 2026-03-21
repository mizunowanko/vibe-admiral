---
name: implement
description: Issue ベースの機能実装ワークフロー。計画→実装→受け入れテ スト→マージまで一気通貫で実行する。"/implement", "実装して" などで起動。
user-invocable: true
---

# /implement — 統合実装スキル（オーケストレータ）

GitHub Issues をベースに、計画→実装→**code-review**→受け入れテスト→マージまでを一気通貫で行う。
実際の処理は 5 つの sub-skill に委譲する。

## 引数

- Issue 番号（例: `#42`, `42`）または Issue タイトルの一部（省略可）

## CRITICAL: Resume Check

```bash
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
if [ "${VIBE_ADMIRAL}" = "true" ]; then echo "VIBE_ADMIRAL_ENABLED"; else echo "VIBE_ADMIRAL_DISABLED"; fi
```

- `VIBE_ADMIRAL_ENABLED`（Admiral モード）: Worktree/ラベル管理スキッ プ、DB メッセージボード方式
- `VIBE_ADMIRAL_DISABLED`（スタンドアロン）: Worktree/ラベル管理をスキル内で実行

## ステータス遷移（admiral-request プロトコル）

**`VIBE_ADMIRAL` 設定時のみ。** Ship はステータス遷移を admiral-request ブロックで Engine に表明する。

### 遷移の表明

````
```admiral-request
{ "request": "status-transition", "status": "<phase-name>" }
```
````

### Engine レスポンス待機（DB ポーリング）

```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"
SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
while true; do
  ROW=$(sqlite3 "$DB_PATH" "SELECT payload FROM messages WHERE ship_id='$SHIP_ID' AND type='admiral-request-response' AND read_at IS NULL LIMIT 1" 2>/dev/null)
  if [ -n "$ROW" ]; then
    sqlite3 "$DB_PATH" "UPDATE messages SET read_at=datetime('now') WHERE ship_id='$SHIP_ID' AND type='admiral-request-response' AND read_at IS NULL"
    echo "$ROW"
    break
  fi
  sleep 1
done
```

- `ok: true` → 遷移確定
- `ok: false` + `gate` フィールドあり → Ship 自身が Escort sub-agent を起動して Gate review を実施

### Gate フロー（Ship Escort 方式）

Engine 応答に `gate` フィールドが含まれる場合:
1. Ship が Escort (sub-agent) を Task tool で起動（`/gate-plan-review` or `/gate-code-review` スキル参照）
2. Escort がレビュー実施 → GitHub に記録 → DB に `gate-response` を書き込み
3. Ship が DB をポーリングして gate-response を取得
4. `approved: true` → 再度 `status-transition` を表明 → Engine が gate 完了を確認して遷移
5. `approved: false` → GitHub でフィードバックを確認、修正して再度 `status-transition` → Escort 起動ループ

### Gate 付き遷移

| 遷移 | Gate タイプ | 内容 |
|------|-----------|------|
| `planning → planning-gate` | plan-review | Ship の Escort が計画の妥当性を検証 |
| `implementing → implementing-gate` | code-review | Ship の Escort が PR の品質を検証 |
| `acceptance-test → acceptance-test-gate` | playwright | Ship の Escort が Playwright E2E テストで品質を検証（`qaRequired: false` の場合スキップ） |

## Sub-Skill ルーティング

`currentStep` に基づいて対応する sub-skill の手順に従う:

| currentStep | Sub-Skill | 内容 |
|-------------|-----------|------|
| 1-2 | `/implement-setup` | Issue 特定、worktree 作成 |
| 3-4 | `/implement-plan` | 調査、計画、plan-review gate |
| 5-8 | `/implement-code` | **Issue 再読み込み** → 実装、ビルド、統合、再テスト |
| 9-10 | `/implement-review` | コミット、PR、**code-review gate** |
| 11-16 | `/implement-merge` | 受入テスト、CI、マージ、done 遷移、クリーンアップ |

> **フェーズ順序制約**: 各 sub-skill は上から順に実行する。code-review gate (`/implement-review`) の承認を得てから受け入れテスト (`/implement-merge`) に進む。順序のスキップ・逆転は禁止。

> **コンテキストリフレッシュ**: `/implement-code` の Step 5a で Issue 全文（plan コメント含む）を再読み込みする。Planning phase の調査でコンテキストが膨らんでいるため、承認済み plan を GitHub から読み直してフレッシュな状態で実装を開始する。

state が `NO_STATE` の場合は Step 1 (`/implement-setup`) から開始する 。

**`VIBE_ADMIRAL` 未設定時**:
admiral-request ブロックは不要。フェーズ宣言もスキップしてよい。
ワークフローの詳細は各 sub-skill を参照。

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
- 各ステップで問題が発生したらその場で解決してから次に進む
- ローカルでは関連テストのみ実行し、コンテキスト消費を最小限にする
- 全テストの網羅的な確認は CI に委ねる
- 競合リスク: CLAUDE.md の Conflict Risk Areas を参照
