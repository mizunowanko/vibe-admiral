# /admiral-protocol — Admiral-Request Protocol Reference

Bridge/Ship 共通の admiral-request プロトコル仕様。
トリガー: admiral-request の仕様確認が必要なとき。

## Admiral-Request Protocol

For operations that ONLY the Engine can perform (Ship management), use `admiral-request` blocks:

```admiral-request
{ ... JSON request ... }
```

The Engine intercepts these blocks, executes them, and returns results to you.

## Bridge Requests (5 total)

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

## Ship Requests (1 total)

Note: `status-transition` was removed in #439. Ships now update the `phases` table directly via `sqlite3` CLI.

### 1. nothing-to-do
Signal that no actionable work was found.

```admiral-request
{ "request": "nothing-to-do", "reason": "..." }
```

## DB Message Board (VIBE_ADMIRAL mode)

In Admiral mode, Ship processes communicate with the Engine via a SQLite `messages` table instead of file-based message boards.

### Environment Variables
- `VIBE_ADMIRAL_SHIP_ID`: The Ship's unique ID
- `VIBE_ADMIRAL_DB_PATH`: Path to the fleet's SQLite database
- `VIBE_ADMIRAL_MAIN_REPO`: The fleet's main repository (owner/repo)

### Message Types
| Type | Sender | Description |
|------|--------|-------------|
| `gate-response` | escort/engine | Gate approval/rejection result (written by Ship's Escort sub-agent) |
| `admiral-request-response` | engine | Response to admiral-request |
| `acceptance-test-request` | ship | Request for acceptance testing (URL + checks) |
| `acceptance-test-response` | engine | Acceptance test result |

### Gate Flow (Ship Escort Model)

Gate checks are handled autonomously by Ships via direct DB updates:

1. Ship directly updates `phases` table to gate phase (e.g. `planning` → `planning-gate`) via `sqlite3`
2. Ship launches Escort sub-agent via Task tool (see `/gate-plan-review`, `/gate-code-review`)
3. Escort performs review, records on GitHub, writes `gate-response` to DB via `sqlite3`
4. Ship polls DB for `gate-response`, reads result
5. On approval: Ship directly updates `phases` table to next work phase (e.g. `planning-gate` → `implementing`)

### Polling Pattern
```bash
DB_PATH="$VIBE_ADMIRAL_DB_PATH"
SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
while true; do
  ROW=$(sqlite3 "$DB_PATH" "SELECT payload FROM messages WHERE ship_id='$SHIP_ID' AND type='<message-type>' AND read_at IS NULL LIMIT 1" 2>/dev/null)
  if [ -n "$ROW" ]; then
    sqlite3 "$DB_PATH" "UPDATE messages SET read_at=datetime('now') WHERE ship_id='$SHIP_ID' AND type='<message-type>' AND read_at IS NULL"
    echo "$ROW"
    break
  fi
  sleep 2
done
```

## Ship Status Confirmation Rules

Bridge MUST follow these rules when dealing with Ship state information:

1. **Always call `ship-status` before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first issue a `ship-status` admiral-request. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

## Handling Results
When the Engine returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.
