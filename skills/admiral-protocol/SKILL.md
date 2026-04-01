---
name: admiral-protocol
description: Engine HTTP API reference for Commander (Flagship/Dock) operations only. Ship/Escort APIs are in /implement and /escort skills.
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

### 6. restart — Restart Engine + Frontend

```bash
curl -s http://localhost:9721/api/restart -X POST
```

- Triggers a graceful restart of Engine and Frontend (Vite dev server)
- Engine broadcasts `engine:restarting` to all WebSocket clients, then shuts down
- The dev-runner automatically restarts both processes
- Ship phases persist in DB and survive the restart
- **Safety**: Always confirm with the human user before calling this endpoint

### 11. commander-notify — Send Heads-Up Notification to Another Commander

```bash
curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/commander-notify \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "flagship",
    "to": "dock",
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "summary": "Ship #42 が planning-gate で 3 回連続 reject されている",
    "shipId": "ship-uuid",
    "issueNumber": 42,
    "severity": "warning",
    "needsInvestigation": true
  }'
```

- `from` (required): Sender role — `"flagship"` or `"dock"`
- `to` (required): Target role — `"dock"` or `"flagship"` (must differ from `from`)
- `fleetId` (required): Fleet ID
- `summary` (required): Problem description
- `severity` (required): `"info"`, `"warning"`, or `"urgent"`
- `needsInvestigation` (required): Whether Dispatch investigation is recommended
- `shipId` (optional): Related Ship ID
- `issueNumber` (optional): Related Issue number
- Returns 200 if delivered, 503 if target Commander is not running

**Use case**: Flagship discovers a Ship problem → sends heads-up to Dock → Dock creates/triages an Issue. This keeps Flagship focused on Ship management while Dock handles Issue management.

## Error Handling

All endpoints return structured JSON:
- **200**: `{ "ok": true, "result": "..." }` — operation succeeded
- **400**: `{ "ok": false, "error": "..." }` — validation error (bad input)
- **404**: `{ "ok": false, "error": "..." }` — unknown endpoint
- **500**: `{ "ok": false, "error": "..." }` — internal error

Flagship can check `ok` field or HTTP status code to detect failures.

## Ship Status Confirmation Rules

Flagship MUST follow these rules when dealing with Ship state information:

1. **Always query via API before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first run `curl -s http://localhost:9721/api/ships`. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

> **Debug only**: `sqlite3 "$VIBE_ADMIRAL_DB_PATH" "SELECT ..."` is available for troubleshooting but should not be used for normal operations.

## Handling Results
When the API returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.
