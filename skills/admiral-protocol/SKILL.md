# /admiral-protocol — Admiral-Request Protocol Reference

Bridge/Ship 共通の admiral-request プロトコル仕様。
トリガー: admiral-request の仕様確認が必要なとき。

## Admiral-Request Protocol

For operations that ONLY the Engine can perform (Ship management), use `admiral-request` blocks:

```admiral-request
{ ... JSON request ... }
```

The Engine intercepts these blocks, executes them, and returns results to you.

## Bridge Requests (8 total)

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

### 5. gate-result
Submit the result of a gate phase check.

```admiral-request
{ "request": "gate-result", "shipId": "uuid", "gatePhase": "planning-gate", "verdict": "approve" }
```

Valid gate phases: `planning-gate`, `implementing-gate`, `acceptance-test-gate`

### 6. gate-ack
Acknowledge receipt of a Gate Check Request. Send IMMEDIATELY when you receive a `[Gate Check Request]` — BEFORE launching Dispatch.

```admiral-request
{ "request": "gate-ack", "shipId": "uuid", "gatePhase": "planning-gate" }
```

**CRITICAL**: Always send `gate-ack` before launching the Dispatch.

### 7. ship-resume
Resume a Ship with a dead process.

```admiral-request
{ "request": "ship-resume", "shipId": "uuid-of-ship" }
```

- Only works on Ships whose process has died (processDead).
- Preferred over re-sortie because it preserves context.

### 8. escort-registered
Register an Escort (persistent sub-agent) for a Ship. Sent by the Escort itself on first launch.

```admiral-request
{ "request": "escort-registered", "shipId": "uuid-of-ship", "agentId": "agent-id-from-task" }
```

- Engine stores the agent ID on the Ship for subsequent gate checks.
- Future gate messages include `Escort agent ID: <id>` so Bridge can resume the same agent via `Task(resume="<id>")`.
- Optional `issueNumber` field for fallback Ship resolution.

## Ship Requests (2 total)

### 1. status-transition
Request a phase transition.

```admiral-request
{ "request": "status-transition", "status": "implementing", "planCommentUrl": "https://...", "qaRequired": true }
```

- `status` field: the target phase (e.g. `"implementing"`, `"acceptance-test"`, `"merging"`, `"done"`)
- Optional `planCommentUrl`: URL of the plan comment (when transitioning to `implementing`)
- Optional `qaRequired`: whether Playwright QA is needed (when transitioning to `implementing`)

### 2. nothing-to-do
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
| `gate-response` | engine | Gate approval/rejection result |
| `admiral-request-response` | engine | Response to admiral-request |
| `acceptance-test-request` | ship | Request for acceptance testing (URL + checks) |
| `acceptance-test-response` | engine | Acceptance test result |

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

3. **Call `ship-status` before Gate Dispatches.** Before launching any Gate Check Dispatch (`/gate-plan-review`, `/gate-code-review`), call `ship-status` to verify the target Ship is still in the expected state. If the Ship's process is dead or phase is `done`, skip the Dispatch.

## Gate Reminders
If you receive a `[REMINDER] [Gate Check Request]`, it means a gate check is still pending. Check `ship-status` and either resume a stalled Dispatch or launch a new one.

## Handling Results
When the Engine returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.

## Handling Gate-Result Errors
When you receive a `[Gate Result Failed]` or `[Request Error]`:
1. Do NOT retry the same gate-result
2. Call `ship-status` to refresh understanding
3. If the Ship's process is dead or phase is `done`, acknowledge and move on
