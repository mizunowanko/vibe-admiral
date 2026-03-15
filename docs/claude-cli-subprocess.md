# Claude Code CLI Subprocess Patterns

This document describes how vibe-admiral spawns and communicates with Claude Code CLI subprocesses. The two primary patterns are **Ship** (one-shot task execution) and **Bridge** (interactive long-running chat).

## Subprocess Spawn Patterns

### Ship (One-Shot Task)

A Ship executes a single issue implementation end-to-end using `-p` (prompt mode). The CLI receives the full prompt at launch and runs to completion without further user input.

```ts
// engine/src/process-manager.ts — sortie()
const proc = spawn(
  "claude",
  [
    "-p",
    `/implement ${issueNumber}`,
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--disallowedTools", "EnterPlanMode,ExitPlanMode",
    "--max-turns", "200",
    "--verbose",
  ],
  {
    cwd: worktreePath,
    env: { ...process.env, VIBE_ADMIRAL: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
```

Key characteristics:
- **`stdio: ['ignore', 'pipe', 'pipe']`** -- stdin is `'ignore'` to avoid the Bun pipe bug (see [Known Gotchas](#known-gotchas)).
- **`-p <prompt>`** -- one-shot prompt mode; the entire task is described in the prompt argument.
- **`--dangerously-skip-permissions`** -- non-interactive, no human to approve tool usage.
- **`--disallowedTools EnterPlanMode,ExitPlanMode`** -- prevents the plan mode exit issue (see [Known Gotchas](#known-gotchas)).
- **`--max-turns 200`** -- generous turn limit for complex implementations.
- **`VIBE_ADMIRAL=true`** -- environment variable to let skills detect they are running inside the Admiral.

### Session Resume

When a Ship needs to be resumed (e.g., after acceptance test feedback), a new process is spawned with `--resume`:

```ts
// engine/src/process-manager.ts — resumeSession()
const proc = spawn(
  "claude",
  [
    "--resume", sessionId,
    "-p", message,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--disallowedTools", "EnterPlanMode,ExitPlanMode",
  ],
  {
    cwd,
    env: { ...process.env, VIBE_ADMIRAL: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
```

Same `stdio` and flag patterns as `sortie()`, with the addition of `--resume <sessionId>` and a follow-up message via `-p`.

### Bridge (Interactive / Long-Running)

A Bridge is an interactive chat session that accepts multiple user messages over time. It uses `--input-format stream-json` to receive messages via stdin.

```ts
// engine/src/process-manager.ts — launchBridge()
const proc = spawn(
  "claude",
  [
    "-p", "",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools",
    "Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,Task,TaskOutput",
    // Optional:
    "--append-system-prompt", systemPrompt,
    "--add-dir", additionalDir,
  ],
  {
    cwd: fleetPath,
    stdio: ["pipe", "pipe", "pipe"],
  },
);
```

Key characteristics:
- **`stdio: ['pipe', 'pipe', 'pipe']`** -- stdin is a pipe for sending messages.
- **`-p ""`** -- empty initial prompt; real messages are sent via stdin.
- **`--input-format stream-json`** -- enables JSON-based stdin messaging.
- **`--allowedTools`** -- restricts the Bridge to read-only/analysis tools (no file editing).
- **`--append-system-prompt`** -- injects a system prompt for fleet-specific context.
- **`--add-dir`** -- adds additional repository directories to the session context.

## Stdin Message Format

For Bridge sessions (which have `--input-format stream-json`), messages are sent to stdin as newline-delimited JSON:

```ts
// engine/src/process-manager.ts — sendMessage()
const payload = JSON.stringify({
  type: "user",
  message: { role: "user", content: message },
});
proc.stdin.write(payload + "\n");
```

The format is:

```json
{"type":"user","message":{"role":"user","content":"Your message here"}}\n
```

Important: Write to stdin immediately after spawning. Do **not** wait for an init message before sending the first message. See [Bun stdin pipe bug](#bun-stdin-pipe-bug) for why.

## Stdout Message Types

All stdout output uses `--output-format stream-json`. Each line is a JSON object. The Engine parses lines in a newline-delimited streaming fashion:

```ts
// engine/src/process-manager.ts — setupProcess()
let buffer = "";
proc.stdout?.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";  // keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    this.emit("data", id, msg);
  }
});
```

### Common message types

| `type` field | Description | Key fields |
|---|---|---|
| `system` (subtype `init`) | Session initialized | `session_id`, `tools` |
| `assistant` | Text response from Claude | `content` |
| `tool_use` | Claude invokes a tool | `tool`, `toolInput` |
| `tool_result` | Result of a tool invocation | `content` |
| `result` | Final result (session complete) | `content`, `subtype` (`success`/`error`) |

### Phase detection from stream

The `ShipManager.updatePhaseFromStream()` method detects Ship progress by inspecting stream messages:

- **`assistant`** content containing `EnterPlanMode` / `ExitPlanMode` -- planning/implementing phases.
- **`tool_use`** with tool `Edit` or `Write` -- implementing phase.
- **`tool_use`** with tool `Bash` containing `npm test` or `vitest` -- testing phase.
- **`tool_use`** with tool `Bash` containing `gh pr create` or `gh pr merge` -- merging phase.
- **`tool_use`** with tool `Skill` or `Task` containing `review-pr` -- reviewing phase.

## Useful CLI Flags

| Flag | Purpose | Used in |
|---|---|---|
| `-p <prompt>` | One-shot prompt mode (non-interactive) | Ship, Bridge |
| `--output-format stream-json` | JSON streaming output on stdout | Ship, Bridge |
| `--input-format stream-json` | JSON streaming input on stdin | Bridge |
| `--session-id <id>` | Set a specific session ID | (available, not currently used) |
| `--resume <session-id>` | Resume a previous session | Session resume |
| `--verbose` | Include detailed tool use info in stream output | Ship, Bridge |
| `--dangerously-skip-permissions` | Skip all tool permission prompts | Ship |
| `--allowedTools <tools>` | Whitelist of allowed tools (comma-separated) | Bridge |
| `--disallowedTools <tools>` | Blacklist of disallowed tools (comma-separated) | Ship |
| `--append-system-prompt <text>` | Append text to the system prompt | Bridge |
| `--add-dir <path>` | Add additional directory to session context | Bridge |
| `--max-turns <n>` | Maximum number of conversation turns | Ship |

## Known Gotchas

### Bun stdin pipe bug

Claude Code CLI is built on Bun, which has a known issue: when stdin is a pipe, Bun replaces pipe file descriptors with Unix sockets. This can break stdout capture.

**Ship / Session Resume workaround:**

Use `stdio: ['ignore', 'pipe', 'pipe']` -- since Ships don't need stdin (the prompt is passed via `-p`), ignoring stdin avoids the issue entirely.

**Bridge workaround:**

Use `stdio: ['pipe', 'pipe', 'pipe']` but **write to stdin immediately** after spawn. Do not use a queue or wait for an init/ready message before writing:

```ts
// engine/src/bridge.ts — send()
// Send immediately -- writing to stdin also unblocks Bun's pipe handling.
// Do NOT queue/defer: Bun blocks stdout when stdin pipe is idle,
// so waiting for init creates a deadlock (init never arrives).
this.processManager.sendMessage(bridgeId, message);
```

The underlying issue is:
1. When stdin is a pipe, Bun may block stdout until stdin has received data.
2. If you wait for an `init` message from stdout before writing to stdin, you get a **deadlock**: the init message never arrives because stdout is blocked waiting for stdin activity.
3. The solution is to write to stdin immediately. The pipe buffer holds the data until the CLI process is ready to read it.

### Plan mode causes exit in `-p` mode

When using `-p` (non-interactive prompt mode), if the Claude model invokes `EnterPlanMode`, the CLI will exit after `ExitPlanMode` without actually performing the implementation. This is because plan mode in non-interactive mode has no human to approve the plan, so the CLI exits.

**Workaround:** Disable plan mode entirely with `--disallowedTools EnterPlanMode,ExitPlanMode`. The `/implement` skill (SKILL.md) also instructs Claude to skip plan mode when the `VIBE_ADMIRAL` environment variable is set.

### Exit code 0 does not guarantee success

A Ship process may exit with code 0 even when it encounters errors (e.g., "Unknown skill"). The Engine checks whether the Ship reached a late phase (merging, testing, etc.) before marking it as successful. If the Ship exits at an early phase, it is treated as an error and the issue labels are rolled back (`doing` -> `todo`).

### Skill file location

Claude CLI expects skills at `.claude/skills/<name>/SKILL.md` (inside the project directory), not at the repository root `skills/` directory. The `ShipManager.deploySkills()` method copies skills from the main repo's `skills/implement/SKILL.md` to the worktree's `.claude/skills/implement/SKILL.md` during sortie.
