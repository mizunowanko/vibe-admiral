---
name: dock-ship-status
description: Read-only Ship status via direct DB query for Dock
user-invocable: false
---

# /dock-ship-status — Ship Status (DB Direct Query)

Dock 用の Ship ステータス確認方法。
fleet.db を `sqlite3` で直接クエリすることで、Engine 経由の通信に依存せず Ship 状態を取得する。

## Query

```bash
sqlite3 -header -column "$VIBE_ADMIRAL_DB_PATH" \
  "SELECT s.id, s.issue_number, s.issue_title, p.phase, s.created_at
   FROM ships s
   JOIN phases p ON s.id = p.ship_id
   WHERE s.completed_at IS NULL
   ORDER BY s.created_at DESC;"
```

- `VIBE_ADMIRAL_DB_PATH` 環境変数で DB パスを取得する
- DB は WAL モードのため読み取りは安全

## Ship Status Confirmation Rules

1. **Always query the DB before reporting to the user.** Never rely on Ship information from conversation history.
2. **Context-cached Ship data is stale.** After context compaction, treat Ship information as hints, not facts.

## Handling Results

Summarize in natural language. Omit internal Ship UUIDs and gate metadata.
