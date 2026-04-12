---
name: fleet-config
description: Fleet 設定の参照・更新。customInstructions, gatePrompts, maxSorties 等を Engine API 経由で操作する。
user-invocable: true
argument-hint: [get|set <field> <value>]
---

# /fleet-config — Fleet 設定の参照・更新

Commander（Flagship/Dock）が Fleet 設定を Engine REST API 経由で参照・更新するスキル。

## 参照 — 現在の Fleet 設定を表示

```bash
curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config?fleetId=${VIBE_ADMIRAL_FLEET_ID}" | jq .
```

### レスポンス例

```json
{
  "ok": true,
  "fleet": {
    "id": "uuid",
    "name": "my-fleet",
    "repos": [...],
    "customInstructions": {
      "shared": "全 Unit 共通の指示",
      "ship": "Ship 用の指示",
      "escort": "Escort 用の指示",
      "flagship": "Flagship 用の指示",
      "dock": "Dock 用の指示"
    },
    "gates": {
      "plan-gate": true,
      "coding-gate": "code-review",
      "qa-gate": "auto-approve"
    },
    "gatePrompts": {
      "code-review": "カスタムレビュー指示"
    },
    "qaRequiredPaths": ["src/critical/**"],
    "acceptanceTestRequired": true,
    "maxConcurrentSorties": 6
  }
}
```

## 更新 — Fleet 設定を部分更新

`PATCH /api/fleet-config` で指定フィールドのみ更新する。`fleetId` は body に含める。

### customInstructions の更新

```bash
curl -s -X PATCH http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "customInstructions": {
      "shared": "全 Unit 共通の新しい指示",
      "ship": "Ship 用の新しい指示",
      "escort": "Escort 用の指示",
      "flagship": "Flagship 用の指示",
      "dock": "Dock 用の指示"
    }
  }'
```

**注意**: `customInstructions` はオブジェクト全体を置き換える。既存の値を保持したい場合は、先に GET で現在値を取得し、変更したいフィールドだけ書き換えてから PATCH する。

### gatePrompts の更新（GATE_PROMPT）

```bash
curl -s -X PATCH http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "gatePrompts": {
      "code-review": "新しい code-review のカスタム指示"
    }
  }'
```

GateType: `"plan-review"`, `"code-review"`, `"playwright"`, `"auto-approve"`

### maxConcurrentSorties の変更

```bash
curl -s -X PATCH http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "maxConcurrentSorties": 4
  }'
```

### gates の設定変更

```bash
curl -s -X PATCH http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "gates": {
      "plan-gate": true,
      "coding-gate": "code-review",
      "qa-gate": "auto-approve"
    }
  }'
```

### acceptanceTestRequired の変更

```bash
curl -s -X PATCH http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "acceptanceTestRequired": false
  }'
```

## 更新可能フィールド一覧

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `customInstructions` | `CustomInstructions` | Unit 別カスタム指示（shared/ship/escort/flagship/dock） |
| `gatePrompts` | `Record<GateType, string>` | Gate 別のカスタムプロンプト |
| `gates` | `Record<GatePhase, GateConfig>` | Gate の有効/無効・種別設定 |
| `maxConcurrentSorties` | `number` | 最大同時 Sortie 数 |
| `acceptanceTestRequired` | `boolean` | 受け入れテスト必須フラグ |
| `qaRequiredPaths` | `string[]` | QA 必須パスの glob パターン |

## 変更後の確認

更新後は GET で変更が反映されたことを確認する:

```bash
curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet-config?fleetId=${VIBE_ADMIRAL_FLEET_ID}" | jq '.fleet.customInstructions'
```

## 注意事項

- 更新時、Engine は稼働中の両 Commander（Flagship/Dock）に自動通知する
- customInstructions の変更は**次回の Ship/Escort 起動時**から反映される（稼働中のセッションには影響しない）
- Commander 自身の customInstructions 変更も次回起動時から反映（稼働中は旧設定のまま）
- `name`, `repos`, `skillSources` 等はこの API では更新不可（UI から変更）
