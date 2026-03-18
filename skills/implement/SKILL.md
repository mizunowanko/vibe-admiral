---
name: implement
description: Issue ベースの機能実装ワークフロー。計画→実装→受け入れテスト→マージまで一気通貫で実行する。"/implement", "実装して" などで起動。
user-invocable: true
---

# /implement — 統合実装スキル（オーケストレータ）

GitHub Issues をベースに、計画→実装→受け入れテスト→マージまでを一気通貫で行う。
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

- `VIBE_ADMIRAL_ENABLED`（Admiral モード）: Worktree/ラベル管理スキップ、ファイル伝言板方式
- `VIBE_ADMIRAL_DISABLED`（スタンドアロン）: Worktree/ラベル管理をスキル内で実行

## ステータス遷移（admiral-request プロトコル）

**`VIBE_ADMIRAL` 設定時のみ。** Ship はステータス遷移を admiral-request ブロックで Engine に表明する。

### 遷移の表明

````
```admiral-request
{ "request": "status-transition", "status": "<phase-name>" }
```
````

### Engine レスポンス待機

```bash
while [ ! -f .claude/admiral-request-response.json ]; do sleep 1; done
RESPONSE=$(cat .claude/admiral-request-response.json)
rm -f .claude/admiral-request-response.json
echo "$RESPONSE"
```

- `ok: true` → 遷移確定
- `ok: false` + "Gate check" → Gate 待機フロー

### Gate 待機フロー

```bash
echo "Gate check initiated. Waiting for Bridge approval..."
rm -f .claude/admiral-request-response.json
while [ ! -f .claude/gate-response.json ]; do sleep 2; done
GATE_RESULT=$(cat .claude/gate-response.json)
rm -f .claude/gate-response.json
rm -f .claude/gate-request.json
echo "$GATE_RESULT"
```

- `approved: true` → 次の作業に進む
- `approved: false` → GitHub でフィードバックを確認、修正して再表明

### Gate 付き遷移

| 遷移 | Gate タイプ | 内容 |
|------|-----------|------|
| `planning → implementing` | plan-review | 計画の妥当性検証 |
| `implementing → acceptance-test` | code-review | PR の品質検証 |
| `acceptance-test → merging` | playwright | E2E テストで品質検証 |

## Sub-Skill ルーティング

`currentStep` に基づいて対応する sub-skill の手順に従う:

| currentStep | Sub-Skill | 内容 |
|-------------|-----------|------|
| 1-2 | `/implement-setup` | Issue 特定、worktree 作成 |
| 3-4 | `/implement-plan` | 調査、計画、plan-review gate |
| 5-8 | `/implement-code` | 実装、ビルド、統合、再テスト |
| 9-11 | `/implement-review` | コミット、PR、code-review、受入テスト |
| 12-16 | `/implement-merge` | CI、マージ、done 遷移、クリーンアップ |

state が `NO_STATE` の場合は Step 1 (`/implement-setup`) から開始する。

## 注意事項

- `.env` は読み書きしない
- 大きな変更は複数回に分けてコミットしてよい
- 各ステップで問題が発生したらその場で解決してから次に進む
- ローカルでは関連テストのみ実行し、コンテキスト消費を最小限にする
- 全テストの網羅的な確認は CI に委ねる
- 競合リスク: CLAUDE.md の Conflict Risk Areas を参照
