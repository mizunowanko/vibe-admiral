---
name: admiral-protocol
description: Engine HTTP API reference for Ship management operations (sortie, ship-status, etc.)
user-invocable: false
---

# /admiral-protocol — Engine HTTP API Reference

Flagship 用の Ship 管理 API リファレンス。
トリガー: Ship 管理操作（sortie, ship-status, ship-stop, ship-resume, pr-review-result）の実行が必要なとき。

## Overview

Engine は HTTP REST API を提供する。Flagship は `curl` を Bash ツール経由で呼び出す。

- **Base URL**: `http://localhost:${ENGINE_PORT:-9721}`
- **Response format**: JSON `{ "ok": true, "result": "..." }` or `{ "ok": false, "error": "..." }`
- **fleetId**: 複数 Fleet がある場合は body に `"fleetId": "..."` を含める（1つの場合は省略可）

## Endpoints

### 1. sortie — Launch Ships

```bash
curl -s http://localhost:9721/api/sortie \
  -H 'Content-Type: application/json' \
  -d '{"items": [{"repo": "owner/repo", "issueNumber": 42}]}'
```

- `items` (required): Array of `{ repo, issueNumber, skill? }`
- `skill` (optional): Defaults to "/implement"
- Multiple issues can be launched in a single call
- Only sortie issues that are UNBLOCKED and have the "status/ready" label

### 2. ship-status — Get Ship Status

```bash
curl -s http://localhost:9721/api/ship-status
```

Returns the current status of all Ships in the fleet.

### 3. ship-stop — Stop a Ship

```bash
curl -s http://localhost:9721/api/ship-stop \
  -H 'Content-Type: application/json' \
  -d '{"shipId": "uuid-of-ship"}'
```

### 4. ship-resume — Resume a Dead Ship

```bash
curl -s http://localhost:9721/api/ship-resume \
  -H 'Content-Type: application/json' \
  -d '{"shipId": "uuid-of-ship"}'
```

- Only works on Ships whose process has died (processDead).
- Preferred over re-sortie because it preserves context.

### 5. pr-review-result — Submit PR Review

```bash
curl -s http://localhost:9721/api/pr-review-result \
  -H 'Content-Type: application/json' \
  -d '{"shipId": "uuid-of-ship", "prNumber": 42, "verdict": "approve"}'
```

- `verdict`: `"approve"` or `"request-changes"`
- `comments` (optional): Review comments string

## Error Handling

All endpoints return structured JSON:
- **200**: `{ "ok": true, "result": "..." }` — operation succeeded
- **400**: `{ "ok": false, "error": "..." }` — validation error (bad input)
- **404**: `{ "ok": false, "error": "..." }` — unknown endpoint
- **500**: `{ "ok": false, "error": "..." }` — internal error

Flagship can check `ok` field or HTTP status code to detect failures.

## Environment Variables (VIBE_ADMIRAL mode)

- `VIBE_ADMIRAL_SHIP_ID`: The Ship's unique ID
- `VIBE_ADMIRAL_DB_PATH`: Path to the fleet's SQLite database
- `VIBE_ADMIRAL_MAIN_REPO`: The fleet's main repository (owner/repo)

## Gate Flow (Engine Escort Model)

Gate checks are handled autonomously by Ships via direct DB updates:

1. Ship directly updates `phases` table to gate phase (e.g. `planning` → `planning-gate`) via `sqlite3`
2. Ship launches Escort sub-agent via Task tool (see `/gate-plan-review`, `/gate-code-review`)
3. Escort performs review, records on GitHub, directly updates `phases` table and writes to `phase_transitions` via `sqlite3`
4. Ship polls `phases` table for phase changes
5. On approval: Escort has already updated phase to next work phase (e.g. `planning-gate` → `implementing`)
6. On rejection: Escort reverts phase (e.g. `planning-gate` → `planning`); Ship reads feedback from `phase_transitions`

### Gate Polling Pattern (phases table)
```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"
SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
while true; do
  PHASE=$(sqlite3 "$DB_PATH" "SELECT phase FROM phases WHERE ship_id='$SHIP_ID'" 2>/dev/null)
  case "$PHASE" in
    <expected-next-phase>) echo "Gate approved"; break ;;
    <rejection-phase>) echo "Gate rejected"; break ;;
    <current-gate-phase>) sleep 2 ;;
  esac
done
```

### Feedback Retrieval (on rejection)
```bash
FEEDBACK=$(sqlite3 "$VIBE_ADMIRAL_DB_PATH" "
  SELECT json_extract(metadata, '$.feedback')
  FROM phase_transitions
  WHERE ship_id = '$VIBE_ADMIRAL_SHIP_ID'
  ORDER BY created_at DESC LIMIT 1
")
```

## Ship Status Confirmation Rules

Flagship MUST follow these rules when dealing with Ship state information:

1. **Always call the `ship-status` API before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first call `GET /api/ship-status`. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

## Handling Results
When the API returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.
