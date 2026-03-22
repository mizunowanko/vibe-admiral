# Claude Code CLI Subprocess Rules

Rules for spawning and communicating with Claude Code CLI as a subprocess.
See `engine/src/process-manager.ts` for the implementation.

## stdio Configuration

- **Ship / Session Resume / Escort**: `stdio: ['ignore', 'pipe', 'pipe']`
  - stdin MUST be `'ignore'`. Claude CLI is built on Bun, which replaces pipe FDs with Unix sockets when stdin is a pipe, breaking stdout capture.
  - Ships and Escorts receive their full prompt via `-p` and don't need stdin.
  - Escort is "just another Ship" launched via `ShipManager.sortieEscort()` with the `/escort` skill. It persists across all gate phases, polling the parent Ship's phase via REST API.

- **Commander (Dock / Flagship)**: `stdio: ['pipe', 'pipe', 'pipe']`
  - stdin is a pipe for sending interactive messages via `--input-format stream-json`.
  - MUST write to stdin immediately after spawn. Do NOT wait for an init message.
  - Bun blocks stdout when stdin pipe is idle, so waiting for init creates a deadlock.

## Tool Restrictions

- **Ship / Escort disallowedTools**: `EnterPlanMode,ExitPlanMode,AskUserQuestion`
  - `EnterPlanMode` / `ExitPlanMode`: In `-p` (prompt) mode, plan mode causes the CLI to exit after `ExitPlanMode` without performing the implementation. There is no human to approve the plan in non-interactive mode.
  - `AskUserQuestion`: Ships and Escorts run non-interactively with stdin ignored.

- **Commander (Dock / Flagship) allowedTools**: `Bash,Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,Task,TaskOutput`
  - Commanders are restricted to read-only and analysis tools (no Write/Edit).
  - `AskUserQuestion` is allowed; the Engine intercepts it, forwards to the frontend, and returns the answer via stdin `tool_result`.

## VIBE_ADMIRAL Environment Variables

Set the following environment variables for all Ship, Escort, and session resume processes:

- `VIBE_ADMIRAL=true` — Signals that skills are running inside the Admiral:
  - Skip worktree creation/deletion (Admiral handles it)
  - Skip label changes (Engine handles it)
  - Skip plan mode (`EnterPlanMode`) and output plan as text instead
  - Use Engine REST API for phase transitions and gate flow instead of `AskUserQuestion`
- `VIBE_ADMIRAL_SHIP_ID` — The Ship's unique ID (set by Engine at sortie/retry)
- `VIBE_ADMIRAL_MAIN_REPO` — The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API port (default: 9721)

Ships and Escorts communicate with Engine exclusively via REST API (`curl`). They do NOT access the database directly.

## Exit Code 0 Does Not Guarantee Success

A Ship process may exit with code 0 even on errors (e.g., "Unknown skill"). The Engine checks whether the Ship reached the merging phase before marking success. Early-phase exits are treated as errors.

## stream-json Output Parsing

stdout is newline-delimited JSON (`--output-format stream-json`). Parse with a line buffer:
1. Accumulate chunks into a buffer
2. Split on `\n`, keep the last (possibly incomplete) segment in the buffer
3. Parse each complete line as JSON
4. Filter out `system` init/hook messages to reduce frontend memory consumption

### Context Compaction Messages

When the CLI compacts its context, two system messages are emitted:
- `{ type: "system", subtype: "status", status: "compacting" }` — compact started
- `{ type: "system", subtype: "status", status: null }` — compact ended (status cleared)
- `{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto"|"manual", pre_tokens: number } }` — compact boundary marker

The Engine detects these to update Ship `isCompacting` state and notify the frontend.

## Stdin Message Format (Commander Only)

Messages to Commander (Dock/Flagship) stdin use `--input-format stream-json`:

```
{"type":"user","message":{"role":"user","content":"message text"}}\n
```

Tool results (for AskUserQuestion answers):

```
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"answer","is_error":false}]}}\n
```

## Skill File Location

Claude CLI expects skills at `.claude/skills/<name>/SKILL.md` inside the project directory, not at the repository root `skills/` directory. The `ShipManager.deploySkills()` method copies skills to worktree during sortie.
