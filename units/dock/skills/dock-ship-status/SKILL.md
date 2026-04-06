---
name: dock-ship-status
description: Read-only Ship status via Engine REST API for Dock
user-invocable: false
---

# /dock-ship-status — Ship Status (API Query)

Dock 用の Ship ステータス確認方法。
Engine REST API を通じて Ship 状態を取得する。

## Query

```bash
curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ships?fleetId=${VIBE_ADMIRAL_FLEET_ID}" | jq '.ships[] | {id, issueNumber, issueTitle, phase, processDead}'
```

- `fleetId` is **required** — omitting it returns a 400 error.
- Phase transition history: `curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/<shipId>/phase-transition-log?limit=10"`

## Ship Status Confirmation Rules

1. **Always query via API before reporting to the user.** Never rely on Ship information from conversation history.
2. **Context-cached Ship data is stale.** After context compaction, treat Ship information as hints, not facts.

## Handling Results

Summarize in natural language. Omit internal Ship UUIDs and gate metadata.

## Debug Only — Direct DB Query

For troubleshooting purposes only. Do not use for normal operations.

```bash
sqlite3 -header -column "$VIBE_ADMIRAL_DB_PATH" \
  "SELECT s.id, s.issue_number, s.issue_title, p.phase, s.created_at
   FROM ships s
   JOIN phases p ON s.id = p.ship_id
   WHERE s.completed_at IS NULL AND s.fleet_id = '$VIBE_ADMIRAL_FLEET_ID'
   ORDER BY s.created_at DESC;"
```

- `VIBE_ADMIRAL_DB_PATH` environment variable provides the DB path
- DB uses WAL mode so concurrent reads are safe
