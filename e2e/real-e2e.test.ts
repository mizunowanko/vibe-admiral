/**
 * Real E2E Test: Bridge → Parallel Ships → Completion
 *
 * Tests the core vibe-admiral flow without mocks:
 *  1. Reset toy project
 *  2. Start Engine on port 9799
 *  3. Connect via WebSocket
 *  4. Create Fleet → Send Bridge message → Ships sortie
 *  5. Wait for all Ships to reach "done"
 *  6. Verify GitHub state (issues closed, PRs exist)
 *  7. Cleanup
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const TSX_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");

const execFileAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────

const ENGINE_PORT = 9799;
const WS_URL = `ws://127.0.0.1:${ENGINE_PORT}`;
const REPO = "mizunowanko-org/toy-admiral-test";
const EXPECTED_ISSUES = [1, 3]; // issues that should be sortied
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min overall
const ENGINE_STARTUP_MS = 3_000; // time to wait for engine to start

// ── Types ───────────────────────────────────────────────────────────

interface WsMessage {
  type: string;
  data?: Record<string, unknown>;
}

interface ShipInfo {
  id: string;
  issueNumber: number;
  issueTitle: string;
  status: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Step 1: Reset toy project ───────────────────────────────────────

async function resetToyProject(): Promise<void> {
  log("Resetting toy project...");
  const { stdout, stderr } = await execFileAsync(
    TSX_BIN,
    ["e2e/reset-toy-project.ts"],
    {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
    },
  );
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  log("Reset complete.");
}

// ── Step 2: Start Engine ────────────────────────────────────────────

function startEngine(): ChildProcess {
  log(`Starting engine on port ${ENGINE_PORT}...`);
  const child = spawn(TSX_BIN, ["engine/src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ENGINE_PORT: String(ENGINE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log(`[engine:stdout] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log(`[engine:stderr] ${line}`);
    }
  });

  child.on("exit", (code) => {
    log(`Engine exited with code ${code}`);
  });

  return child;
}

// ── Step 3: WebSocket client ────────────────────────────────────────

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      log("WebSocket connected.");
      resolve(ws);
    });
    ws.on("error", (err) => {
      reject(new Error(`WebSocket connection failed: ${err.message}`));
    });
  });
}

async function connectWithRetry(
  maxRetries = 10,
  intervalMs = 1000,
): Promise<WebSocket> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await connectWs();
    } catch {
      if (i < maxRetries - 1) {
        await sleep(intervalMs);
      }
    }
  }
  throw new Error(`Failed to connect to engine after ${maxRetries} retries`);
}

function send(ws: WebSocket, msg: WsMessage): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: WsMessage) => boolean,
  timeoutMs: number,
  label: string,
): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`Timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(data: WebSocket.RawData): void {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.on("message", handler);
  });
}

// ── Step 4-6: Main test flow ────────────────────────────────────────

async function runTest(ws: WebSocket): Promise<string> {
  // Track ships and their statuses
  const ships = new Map<string, ShipInfo>();
  const doneShips = new Set<string>();
  const errorShips = new Set<string>();

  // Listen for all messages for logging/tracking
  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;

      switch (msg.type) {
        case "ship:created": {
          const d = msg.data!;
          const info: ShipInfo = {
            id: d.id as string,
            issueNumber: d.issueNumber as number,
            issueTitle: d.issueTitle as string,
            status: d.status as string,
          };
          ships.set(info.id, info);
          log(`Ship created: #${info.issueNumber} "${info.issueTitle}" [${info.id.slice(0, 8)}]`);
          break;
        }
        case "ship:status": {
          const d = msg.data!;
          const id = d.id as string;
          const status = d.status as string;
          // Action-executor path doesn't broadcast ship:created,
          // so we also track ships from ship:status events
          if (!ships.has(id) && d.issueNumber) {
            const info: ShipInfo = {
              id,
              issueNumber: d.issueNumber as number,
              issueTitle: (d.issueTitle as string) ?? "",
              status,
            };
            ships.set(id, info);
            log(`Ship discovered: #${info.issueNumber} "${info.issueTitle}" [${id.slice(0, 8)}]`);
          }
          const ship = ships.get(id);
          if (ship) {
            ship.status = status;
            log(`Ship #${ship.issueNumber} status: ${status}${d.detail ? ` (${d.detail})` : ""}`);
          }
          if (status === "done") doneShips.add(id);
          if (status === "error") errorShips.add(id);
          break;
        }
        case "ship:stream": {
          const d = msg.data!;
          const shipMsg = d.message as Record<string, unknown>;
          const shipId = d.id as string;
          const ship = ships.get(shipId);
          const prefix = ship ? `Ship#${ship.issueNumber}` : `Ship[${shipId.slice(0, 8)}]`;
          const msgType = shipMsg.type as string;
          const content = (shipMsg.content as string) ?? "";

          if (msgType === "assistant" && content) {
            const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
            log(`${prefix}: ${preview}`);
          } else if (msgType === "tool_use") {
            const tool = (shipMsg.tool as string) ?? "unknown";
            const input = shipMsg.toolInput as Record<string, unknown> | undefined;
            const inputPreview = input ? ` ${JSON.stringify(input).slice(0, 100)}` : "";
            log(`${prefix}: [${tool}]${inputPreview}`);
          } else if (msgType === "result") {
            log(`${prefix}: [result] ${content.slice(0, 200)}`);
          } else if (msgType === "system" && content) {
            log(`${prefix}: [system] ${content.slice(0, 200)}`);
          }
          break;
        }
        case "bridge:stream": {
          const d = msg.data!;
          const message = d.message as Record<string, unknown>;
          const type = message.type as string;
          const content = (message.content as string) ?? "";
          if (type === "assistant" && content) {
            // Truncate for readability
            const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
            log(`Bridge: ${preview}`);
          } else if (type === "system" && message.subtype === "action-result") {
            log(`Action result: ${content.slice(0, 200)}`);
          }
          break;
        }
        case "error": {
          const d = msg.data!;
          log(`ERROR [${d.source}]: ${d.message}`);
          break;
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  // 4a. Create Fleet
  log("Creating fleet...");
  send(ws, {
    type: "fleet:create",
    data: { name: "E2E Test Fleet", repos: [REPO] },
  });

  const fleetMsg = await waitForMessage(
    ws,
    (m) => m.type === "fleet:created",
    10_000,
    "fleet:created",
  );
  const fleetId = fleetMsg.data!.id as string;
  log(`Fleet created: ${fleetId}`);

  // 4b. Send Bridge message to sortie all todo issues
  log("Sending Bridge command...");
  send(ws, {
    type: "bridge:send",
    data: {
      fleetId,
      message:
        "List all todo issues in the fleet repos and sortie all unblocked ones immediately. Do not ask for confirmation.",
    },
  });

  // 5. Wait for ships to be created and complete
  log("Waiting for ships to be created and complete...");

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  // Wait until we have at least EXPECTED_ISSUES.length ships created
  while (ships.size < EXPECTED_ISSUES.length && Date.now() < deadline) {
    await sleep(5_000);
    log(`  Ships created: ${ships.size}/${EXPECTED_ISSUES.length}, waiting...`);
  }

  if (ships.size < EXPECTED_ISSUES.length) {
    throw new Error(
      `Only ${ships.size} ships created, expected ${EXPECTED_ISSUES.length}. ` +
        `Timed out after ${TOTAL_TIMEOUT_MS / 1000}s.`,
    );
  }

  log(`All ${ships.size} ships created. Waiting for completion...`);

  // Wait for all ships to reach "done" or "error"
  while (
    doneShips.size + errorShips.size < ships.size &&
    Date.now() < deadline
  ) {
    await sleep(10_000);
    log(
      `  Progress: ${doneShips.size} done, ${errorShips.size} error, ` +
        `${ships.size - doneShips.size - errorShips.size} in progress`,
    );
  }

  if (doneShips.size + errorShips.size < ships.size) {
    throw new Error(
      `Timed out: ${doneShips.size} done, ${errorShips.size} error, ` +
        `${ships.size - doneShips.size - errorShips.size} still running`,
    );
  }

  // 6. Verify results
  log("\n=== RESULTS ===");
  for (const [, ship] of ships) {
    log(`  Ship #${ship.issueNumber} "${ship.issueTitle}": ${ship.status}`);
  }

  if (errorShips.size > 0) {
    log(`\nWARNING: ${errorShips.size} ship(s) ended in error state.`);
  }

  // Check GitHub state
  log("\nVerifying GitHub state...");
  await verifyGitHubState();

  // Final pass/fail
  const passCount = doneShips.size;
  if (passCount >= 2) {
    log(`\nPASS: ${passCount} ships completed successfully.`);
  } else {
    throw new Error(`FAIL: Only ${passCount} ships completed (need >= 2).`);
  }

  return fleetId;
}

// ── Step 6: Verify GitHub state ─────────────────────────────────────

async function verifyGitHubState(): Promise<void> {
  for (const issueNum of EXPECTED_ISSUES) {
    // Check issue is closed
    const issueRaw = await execFileAsync("gh", [
      "issue",
      "view",
      String(issueNum),
      "--repo",
      REPO,
      "--json",
      "state",
    ]);
    const issue = JSON.parse(issueRaw.stdout.trim()) as { state: string };
    const isClosed = issue.state === "CLOSED";
    log(`  Issue #${issueNum}: ${issue.state} ${isClosed ? "OK" : "UNEXPECTED"}`);
  }

  // Check PRs exist
  const prRaw = await execFileAsync("gh", [
    "pr",
    "list",
    "--repo",
    REPO,
    "--state",
    "all",
    "--json",
    "number,title,state",
    "--limit",
    "20",
  ]);
  const prs = JSON.parse(prRaw.stdout.trim()) as Array<{
    number: number;
    title: string;
    state: string;
  }>;
  log(`  PRs found: ${prs.length}`);
  for (const pr of prs) {
    log(`    PR #${pr.number}: "${pr.title}" [${pr.state}]`);
  }

  // Check worktrees are cleaned up
  const wtRaw = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: `${process.env.HOME}/Projects/Development/toy-admiral-test` },
  );
  const worktrees = wtRaw.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.replace("worktree ", ""));
  const extraWorktrees = worktrees.filter(
    (w) =>
      w !== `${process.env.HOME}/Projects/Development/toy-admiral-test`,
  );
  log(
    `  Worktrees remaining (should be 0): ${extraWorktrees.length}${extraWorktrees.length > 0 ? ` — ${extraWorktrees.join(", ")}` : ""}`,
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let engine: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  let fleetId: string | null = null;
  let exitCode = 0;

  try {
    // Step 1: Reset
    await resetToyProject();

    // Step 2: Start engine
    engine = startEngine();
    await sleep(ENGINE_STARTUP_MS);

    // Step 3: Connect
    ws = await connectWithRetry();

    // Steps 4-6: Run test
    fleetId = await runTest(ws);
  } catch (err) {
    console.error(
      "\nTest failed:",
      err instanceof Error ? err.message : err,
    );
    exitCode = 1;
  } finally {
    // Step 7: Cleanup
    log("Cleaning up...");

    // Delete the test fleet before killing the engine
    if (fleetId && ws && ws.readyState === WebSocket.OPEN) {
      log(`Deleting test fleet ${fleetId}...`);
      try {
        send(ws, { type: "fleet:delete", data: { id: fleetId } });
        await waitForMessage(ws, (m) => m.type === "fleet:data", 5_000, "fleet:data");
        log("Test fleet deleted.");
      } catch {
        log("Warning: failed to delete test fleet (timeout or error).");
      }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    if (engine && !engine.killed) {
      engine.kill("SIGTERM");
      // Give it a moment to clean up
      await sleep(2_000);
      if (!engine.killed) {
        engine.kill("SIGKILL");
      }
    }
    log("Done.");
  }

  process.exit(exitCode);
}

main();
