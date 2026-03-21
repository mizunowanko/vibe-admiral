# /admiral-protocol — Admiral-Request Protocol Reference

Bridge/Ship 共通の admiral-request プロトコル仕様。
トリガー: admiral-request の仕様確認が必要なとき。

## Admiral-Request Protocol

For operations that ONLY the Engine can perform (Ship management), use `admiral-request` blocks:

```admiral-request
{ ... JSON request ... }
```

The Engine intercepts these blocks, executes them, and returns results to you.

## Bridge Requests (7 total)

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
Submit the result of a transition gate check.

```admiral-request
{ "request": "gate-result", "shipId": "uuid", "transition": "planning→implementing", "verdict": "approve" }
```

Valid transitions: `planning→implementing`, `implementing→acceptance-test`, `acceptance-test→merging`

### 6. gate-ack
Acknowledge receipt of a Gate Check Request. Send IMMEDIATELY when you receive a `[Gate Check Request]` — BEFORE launching Dispatch.

```admiral-request
{ "request": "gate-ack", "shipId": "uuid", "transition": "planning→implementing" }
```

**CRITICAL**: Always send `gate-ack` before launching the Dispatch.

### 7. ship-resume
Resume an errored Ship.

```admiral-request
{ "request": "ship-resume", "shipId": "uuid-of-ship" }
```

- Only works on Ships in `error` status.
- Preferred over re-sortie because it preserves context.

## Ship Requests (2 total)

### 1. status-transition
Request a phase transition.

```admiral-request
{ "request": "status-transition", "status": "implementing", "planCommentUrl": "https://..." }
```

### 2. nothing-to-do
Signal that no actionable work was found.

```admiral-request
{ "request": "nothing-to-do", "reason": "..." }
```

## Ship Status Confirmation Rules

Bridge MUST follow these rules when dealing with Ship state information:

1. **Always call `ship-status` before reporting to the user.** Whenever you mention Ship status — whether proactively or in response to a question — you MUST first issue a `ship-status` admiral-request. Never rely on Ship information from your conversation history.

2. **Context-cached Ship data is stale.** After context compaction or session resumption, Ship information in your history is outdated. Treat it as hints for planning, never as facts for reporting.

3. **Call `ship-status` before Gate Dispatches.** Before launching any Gate Check Dispatch (`/gate-plan-review`, `/gate-code-review`), call `ship-status` to verify the target Ship is still in the expected state. If the Ship is `error` or `done`, skip the Dispatch.

## Gate Reminders
If you receive a `[REMINDER] [Gate Check Request]`, it means a gate check is still pending. Check `ship-status` and either resume a stalled Dispatch or launch a new one.

## Handling Results
When the Engine returns results, **summarize** in natural language. Omit internal Ship UUIDs and gate metadata.

## Handling Gate-Result Errors
When you receive a `[Gate Result Failed]` or `[Request Error]`:
1. Do NOT retry the same gate-result
2. Call `ship-status` to refresh understanding
3. If the Ship is in `error` or `done`, acknowledge and move on
