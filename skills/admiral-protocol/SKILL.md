---
name: admiral-protocol
description: admiral-request プロトコル仕様。Bridge/Ship が admiral-request を送信する際に参照する
user-invocable: false
---

# /admiral-protocol — Admiral-Request Protocol Reference

Flagship 用の admiral-request プロトコル仕様。
トリガー: admiral-request の仕様確認が必要なとき。

## Admiral-Request Protocol

For operations that ONLY the Engine can perform (Ship management), use `admiral-request` blocks:

```admiral-request
{ ... JSON request ... }
```

The Engine intercepts these blocks, executes them, and returns results to you.

## Flagship Requests (5 total)

### 1. sortie
Launch Ships (Claude Code implementation sessions) for issues.

```admiral-request
{ "request": "sortie", "items": [{ "repo": "owner/repo", "issueNumber": 42 }] }
```

- Only sortie issues that are UNBLOCKED and have the "status/todo" label
- Multiple issues can be launched simultaneously via the `items` array
- Optional `skill` field per item: defaults to "/implement"

### 2. ship-status
Get the current status of all Ships in this fleet.

```admiral-request
{ "request": "ship-status" }
```

### 3. ship-stop
Stop a running Ship by its ID.

```admiral-request
{ "request": "ship-stop", "shipId": "uuid-of-ship" }
```

### 4. pr-review-result
Submit the result of a PR code review.

```admiral-request
{ "request": "pr-review-result", "shipId": "uuid-of-ship", "prNumber": 42, "verdict": "approve" }
```

### 5. ship-resume
Resume a Ship with a dead process.

```admiral-request
{ "request": "ship-resume", "shipId": "uuid-of-ship" }
```

- Only works on Ships whose process has died (processDead).
- Preferred over re-sortie because it preserves context.

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

1. **Always call `ship-status` before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first issue a `ship-status` admiral-request. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

## Handling Results
When the Engine returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.
