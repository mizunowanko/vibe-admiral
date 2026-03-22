---
name: dock-ship-status
description: Read-only Ship status API for Dock (lightweight alternative to admiral-protocol)
user-invocable: false
---

# /dock-ship-status — Ship Status API (Read-Only)

Dock 用の Ship ステータス確認 API リファレンス。
Dock は Ship の状態を読み取ることはできるが、Ship の操作（sortie, stop, resume）は行えない。

## Endpoint

### ship-status — Get Ship Status

```bash
curl -s http://localhost:9721/api/ship-status
```

Returns the current status of all Ships in the fleet.

## Ship Status Confirmation Rules

1. **Always call the `ship-status` API before reporting to the user.** Never rely on Ship information from conversation history.
2. **Context-cached Ship data is stale.** After context compaction, treat Ship information as hints, not facts.

## Handling Results

Summarize in natural language. Omit internal Ship UUIDs and gate metadata.
