# /admiral-protocol — Admiral-Request Protocol Reference

Bridge/Ship 共通の admiral-request プロトコル仕様。
トリガー: admiral-request の仕様確認が必要なとき。

## Admiral-Request Protocol

For operations that ONLY the Engine can perform (Ship management), use `admiral-request` blocks:

```admiral-request
{ ... JSON request ... }
```

The Engine intercepts these blocks, executes them, and returns results to you.

## Bridge Requests (6 total)

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

### 4. gate-result
Submit the result of a transition gate check.

```admiral-request
{ "request": "gate-result", "shipId": "uuid", "transition": "planning→implementing", "verdict": "approve" }
```

```admiral-request
{ "request": "gate-result", "shipId": "uuid", "transition": "implementing→acceptance-test", "verdict": "reject", "feedback": "Description of what needs fixing" }
```

Valid transitions: `planning→implementing`, `implementing→acceptance-test`, `acceptance-test→merging`

### 5. gate-ack
Acknowledge receipt of a Gate Check Request. Send IMMEDIATELY when you receive a `[Gate Check Request]` — BEFORE launching Dispatch. This resets the Engine's timeout window.

```admiral-request
{ "request": "gate-ack", "shipId": "uuid", "transition": "planning→implementing" }
```

**CRITICAL**: Always send `gate-ack` before launching the Dispatch. Without it, the Engine may time out and auto-reject.

## Ship Requests (2 total)

### 1. status-transition
Request a phase transition. The Engine validates and may trigger a gate check.

```admiral-request
{ "request": "status-transition", "status": "implementing", "planCommentUrl": "https://..." }
```

`planCommentUrl` is only required for `implementing` transitions.

### 2. nothing-to-do
Signal that no actionable work was found for the assigned issue.

```admiral-request
{ "request": "nothing-to-do", "reason": "Issue requirements are already satisfied" }
```

## Handling Results

When the Engine returns results for admiral-request blocks, **summarize** in natural language — do NOT relay raw JSON to the user. Omit internal Ship UUIDs and gate metadata.

## Handling Gate-Result Errors

When you receive a `[Gate Result Failed]` or `[Request Error]`:
1. Do NOT retry the same gate-result
2. Call `ship-status` to refresh understanding of all Ship states
3. If the Ship is in `error` or `done`, acknowledge and move on
4. If the Ship has a different pending gate, wait for a new `[Gate Check Request]`
