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
- Only sortie issues that are UNBLOCKED (open issues without `status/sortied` label)

### 2. ship-status — Get Ship Status

```bash
curl -s http://localhost:9721/api/ships | jq '.ships[] | {id, issueNumber, issueTitle, phase, processDead}'
```

- Returns all Ships with current phase, processDead status, gate info, etc.
- For a specific fleet: `curl -s "http://localhost:9721/api/ships?fleetId=..."`
- Phase transition history: `curl -s "http://localhost:9721/api/ship/<shipId>/phase-transition-log?limit=10"`

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
- `VIBE_ADMIRAL_MAIN_REPO`: The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT`: Engine API port (default: 9721)

## Ship/Escort API Endpoints

### 6. phase-transition — Ship transitions its own phase

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition \
  -H 'Content-Type: application/json' \
  -d '{"phase": "planning-gate", "metadata": {"planCommentUrl": "..."}}'
```

- Engine validates the transition (forward-only, gate-reject exception)
- Returns `{ "ok": true, "phase": "planning-gate" }` or `{ "ok": false, "error": "..." }`

### 7. phase — Poll current phase

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase
```

- Returns `{ "ok": true, "phase": "implementing" }`

### 8. gate-verdict — Escort submits gate result

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "approve"}'
```

- `verdict`: `"approve"` or `"reject"`
- `feedback` (optional, for reject): reason string
- Engine validates ship is in a gate phase, then transitions accordingly

### 9. phase-transition-log — Get recent phase transitions

```bash
curl -sf "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition-log?limit=1"
```

- Returns `{ "ok": true, "transitions": [{ "fromPhase": "...", "toPhase": "...", "metadata": {...}, ... }] }`

### 10. nothing-to-do — Ship declares nothing to do

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/nothing-to-do \
  -H 'Content-Type: application/json' \
  -d '{"reason": "Issue already resolved"}'
```

## Gate Flow (Engine REST API Model)

Gate checks are handled via Engine REST API:

1. Ship calls `POST /api/ship/:id/phase-transition` to enter gate phase (e.g. `planning` → `planning-gate`)
2. Engine detects gate phase, launches Escort process with appropriate gate skill
3. Escort performs review, records on GitHub, calls `POST /api/ship/:id/gate-verdict`
4. Ship polls `GET /api/ship/:id/phase` for phase changes
5. On approval: Engine transitions to next work phase (e.g. `planning-gate` → `implementing`)
6. On rejection: Engine reverts to previous phase (e.g. `planning-gate` → `planning`); Ship reads feedback via `GET /api/ship/:id/phase-transition-log`

### Gate Polling Pattern (REST API)
```bash
TIMEOUT=900; ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  RESULT=$(curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase)
  PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
  case "$PHASE" in
    <expected-next-phase>) echo "Gate approved"; break ;;
    <rejection-phase>) echo "Gate rejected"; break ;;
    <current-gate-phase>) sleep 60 ;;
    *) echo "UNEXPECTED_PHASE: $PHASE"; break ;;
  esac
  ELAPSED=$((ELAPSED + 60))
done
[ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

### Feedback Retrieval (on rejection)
```bash
FEEDBACK=$(curl -sf "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase-transition-log?limit=1" | grep -o '"feedback":"[^"]*"' | cut -d'"' -f4)
```

## Ship Status Confirmation Rules

Flagship MUST follow these rules when dealing with Ship state information:

1. **Always query via API before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first run `curl -s http://localhost:9721/api/ships`. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

> **Debug only**: `sqlite3 "$VIBE_ADMIRAL_DB_PATH" "SELECT ..."` is available for troubleshooting but should not be used for normal operations.

## Handling Results
When the API returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.
