---
name: implement
description: Issue ベースの機能実装ワークフロー。計画→実装→受け入れテスト→マージまで一気通貫で実行する。"/implement", "実装して" などで起動。
user-invocable: true
argument-hint: [issue-number]
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

- `VIBE_ADMIRAL_ENABLED`（Admiral モード）: Worktree/ラベル管理スキップ、Engine REST API 経由で phase 遷移
- `VIBE_ADMIRAL_DISABLED`（スタンドアロン）: Worktree/ラベル管理をスキル内で実行

## ステータス遷移（Engine REST API）

**`VIBE_ADMIRAL` 設定時のみ。** Ship は phase 遷移時に Engine REST API を呼び出す。

### Phase 更新テンプレート

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition \
  -H 'Content-Type: application/json' \
  -d '{"phase": "<targetPhase>", "metadata": {}}'
```

### Gate 待ち（REST API ポーリング）

Gate phase に入った後、Escort が phase を更新するのを待つ:

```bash
TIMEOUT=900; ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  RESULT=$(curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase)
  PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
  case "$PHASE" in
    <expected-next-phase>) echo "Gate approved"; break ;;
    <rejection-phase>) echo "Gate rejected"; break ;;
    # NOTE: This sleep is an intentional polling interval, NOT rate limit backoff.
    <current-gate-phase>) sleep 60 ;;
    *) echo "UNEXPECTED_PHASE: $PHASE"; break ;;
  esac
  ELAPSED=$((ELAPSED + 60))
done
[ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

### Gate フロー（Engine Escort 方式）

1. Ship が Engine REST API で gate phase に遷移（例: `planning` → `planning-gate`）
2. Engine が Escort プロセスを起動（`/planning-gate`, `/implementing-gate`, `/acceptance-test-gate` スキル）
3. Escort がレビュー実施 → GitHub に記録 → Engine REST API で gate-verdict を送信
4. Ship が REST API をポーリングして phase 変更を検知
5. approved → Engine が phase を次の作業 phase に更新済み → Ship が検知して次の作業を開始
6. rejected → phase-transition-log API からフィードバックを取得、修正して再度 gate phase に遷移 → Engine が Escort 再起動

### Gate 付き遷移

| 遷移 | Gate タイプ | 内容 |
|------|-----------|------|
| `planning → planning-gate` | plan-review | Ship の Escort が計画の妥当性を検証 |
| `implementing → implementing-gate` | code-review | Ship の Escort が PR の品質を検証 |
| `acceptance-test → acceptance-test-gate` | playwright | Ship の Escort が Playwright E2E テストで品質を検証（`qaRequired: false` の場合スキップ） |

## Sub-Skill ルーティング

`currentStep` に基づいて対応する sub-skill の手順に従う:

| currentStep | Sub-Skill | Sub-Skill Steps | 内容 |
|-------------|-----------|-----------------|------|
| 1-2 | `/implement-setup` | Steps 1-2 | Issue 特定、worktree 作成 |
| 3-4 | `/implement-plan` | Steps 1-2 | 調査、計画、plan-review gate |
| 5-8 | `/implement-code` | Steps 1-4 | **Issue 再読み込み** → 実装、ビルド、統合、再テスト |
| 9-10 | `/implement-review` | Steps 1-2 | コミット、PR、**code-review gate** |
| 11-17 | `/implement-merge` | Steps 1-7 | 受入テスト、CI、マージ、**振り返り**、done 遷移、クリーンアップ |

> **フェーズ順序制約**: 各 sub-skill は上から順に実行する。code-review gate (`/implement-review`) の承認を得てから受け入れテスト (`/implement-merge`) に進む。順序のスキップ・逆転は禁止。

> **コンテキストリフレッシュ**: `/implement-code` の Step 1a で Issue 全文（plan コメント含む）を再読み込みする。Planning phase の調査でコンテキストが膨らんでいるため、承認済み plan を GitHub から読み直してフレッシュな状態で実装を開始する。

state が `NO_STATE` の場合:

1. **`[Re-sortie Context]` が prompt に含まれている場合** — re-sortie。前回の Ship の状態に基づいて resume する:
   - `Previous workflow-state.json` が含まれていれば、その `currentStep` に基づいて `workflow-state.json` を生成し、そこから resume する
   - workflow-state.json がなければ `Suggested /implement start step` の値を使用する
   - ただし `/implement-setup` (Steps 1-2) は常にスキップする（Admiral が worktree を管理済み）
   - workflow-state.json を生成した後、該当する sub-skill のフローに従う
2. **`[Re-sortie Context]` がない場合** — 新規 sortie。Step 1 (`/implement-setup`) から開始する。

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
