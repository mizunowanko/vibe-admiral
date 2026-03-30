/**
 * Stub Claude CLI for E2E testing.
 *
 * Simulates the Claude Code CLI's stream-json output and phase transitions.
 * Used by setting CLAUDE_CLI_PATH to point to this script (via npx tsx).
 *
 * Behavior depends on the prompt (-p argument):
 *   - /implement: Walks through plan → plan-gate → coding → coding-gate → merging → done
 *   - /escort: Submits an "approve" gate-verdict
 *   - Other: Outputs a simple assistant response and exits
 *
 * Environment variables read:
 *   - VIBE_ADMIRAL_SHIP_ID: Ship UUID (used for Engine API calls)
 *   - VIBE_ADMIRAL_ENGINE_PORT: Engine port (default 9721)
 *   - STUB_CLI_MODE: Override behavior ("fast-done", "hang", "fail")
 *   - STUB_CLI_ESCORT_VERDICT: Override escort verdict ("approve" or "reject")
 *   - STUB_CLI_DELAY_MS: Delay between phases in ms (default 100)
 */

const shipId = process.env.VIBE_ADMIRAL_SHIP_ID ?? "";
const enginePort = process.env.VIBE_ADMIRAL_ENGINE_PORT ?? "9721";
const mode = process.env.STUB_CLI_MODE ?? "normal";
const escortVerdict = process.env.STUB_CLI_ESCORT_VERDICT ?? "approve";
const delayMs = parseInt(process.env.STUB_CLI_DELAY_MS ?? "100", 10);
const sessionId = `stub-session-${shipId.slice(0, 8)}-${Date.now()}`;
const engineBase = `http://localhost:${enginePort}`;

// Parse -p argument from CLI args
function getPrompt(): string {
  const args = process.argv.slice(2);
  const pIndex = args.indexOf("-p");
  if (pIndex >= 0 && pIndex + 1 < args.length) {
    return args[pIndex + 1];
  }
  return "";
}

function emit(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitInit() {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: "stub-model",
  });
}

function emitAssistant(text: string) {
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    session_id: sessionId,
  });
}

function emitResult(text: string) {
  emit({
    type: "result",
    result: text,
    session_id: sessionId,
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 50,
    num_turns: 1,
    cost_usd: 0,
    total_cost_usd: 0,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; phase?: string; error?: string }> {
  const url = `${engineBase}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; phase?: string; error?: string };
}

async function transitionPhase(
  phase: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await apiPost(
    `/api/ship/${shipId}/phase-transition`,
    { phase, metadata },
  );
  return result.ok;
}

async function submitGateVerdict(
  verdict: string,
  feedback = "",
): Promise<boolean> {
  const result = await apiPost(
    `/api/ship/${shipId}/gate-verdict`,
    { verdict, feedback },
  );
  return result.ok;
}

// --- Main flows ---

async function runImplementFlow() {
  emitAssistant("Starting /implement flow (stub CLI)...");
  await sleep(delayMs);

  // plan → plan-gate
  emitAssistant("Planning complete. Transitioning to plan-gate...");
  await transitionPhase("plan-gate", {
    planCommentUrl: "stub://plan-comment",
    qaRequired: false,
  });
  await sleep(delayMs);

  // Wait for plan-gate → coding (Escort approves)
  emitAssistant("Waiting for plan-gate approval...");
  const codingReady = await waitForPhase("coding", 120_000);
  if (!codingReady) {
    emitAssistant("Plan-gate not approved in time, exiting.");
    emitResult("Plan gate timeout");
    return;
  }

  // coding → coding-gate
  emitAssistant("Implementation complete. Transitioning to coding-gate...");
  await transitionPhase("coding-gate");
  await sleep(delayMs);

  // Wait for coding-gate → qa or merging
  emitAssistant("Waiting for coding-gate approval...");
  const postCodingGate = await waitForPhase(
    ["qa", "merging"],
    120_000,
  );
  if (!postCodingGate) {
    emitAssistant("Coding-gate not approved in time, exiting.");
    emitResult("Coding gate timeout");
    return;
  }

  // If qa, transition through qa-gate
  const currentPhase = await getCurrentPhase();
  if (currentPhase === "qa") {
    emitAssistant("QA phase. Transitioning to qa-gate...");
    await transitionPhase("qa-gate");
    await sleep(delayMs);

    const mergingReady = await waitForPhase("merging", 120_000);
    if (!mergingReady) {
      emitAssistant("QA-gate not approved in time, exiting.");
      emitResult("QA gate timeout");
      return;
    }
  }

  // merging → done
  emitAssistant("Merging complete. Transitioning to done...");
  await transitionPhase("done");
  await sleep(delayMs);

  emitResult("Ship completed successfully (stub CLI).");
}

async function runEscortFlow() {
  emitAssistant(`Escort reviewing... (will ${escortVerdict})`);
  await sleep(delayMs);

  // Declare intent first (fallback mechanism)
  await apiPost(`/api/ship/${shipId}/gate-intent`, {
    verdict: escortVerdict,
    feedback: escortVerdict === "reject" ? "Stub CLI rejection" : "",
    declaredAt: new Date().toISOString(),
  });

  await sleep(delayMs);

  // Submit verdict
  await submitGateVerdict(
    escortVerdict,
    escortVerdict === "reject" ? "Stub CLI rejection" : "",
  );

  emitResult(`Escort verdict: ${escortVerdict}`);
}

async function getCurrentPhase(): Promise<string> {
  const res = await fetch(
    `${engineBase}/api/ship/${shipId}/phase`,
  );
  const data = (await res.json()) as { ok: boolean; phase: string };
  return data.phase;
}

async function waitForPhase(
  target: string | string[],
  timeoutMs: number,
): Promise<boolean> {
  const targets = Array.isArray(target) ? target : [target];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const phase = await getCurrentPhase();
    if (targets.includes(phase)) return true;
    // If phase became paused/abandoned/done unexpectedly, stop waiting
    if (["paused", "abandoned", "done"].includes(phase)) return false;
    await sleep(1000);
  }
  return false;
}

// --- Entry point ---

async function main() {
  emitInit();

  if (mode === "fast-done") {
    // Immediately transition to done (for simple tests)
    emitAssistant("Fast-done mode: skipping all phases.");
    await transitionPhase("done");
    emitResult("Done (fast mode).");
    return;
  }

  if (mode === "hang") {
    // Stay alive indefinitely (for pause/resume tests)
    emitAssistant("Hang mode: staying alive...");
    await new Promise(() => {}); // Never resolves
    return;
  }

  if (mode === "fail") {
    emitAssistant("Fail mode: exiting with error.");
    emitResult("Intentional failure.");
    process.exit(1);
  }

  const prompt = getPrompt();
  const isEscort = prompt.includes("/escort");

  if (isEscort) {
    await runEscortFlow();
  } else {
    await runImplementFlow();
  }
}

main().catch((err) => {
  process.stderr.write(`stub-cli error: ${err}\n`);
  process.exit(1);
});
