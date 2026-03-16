/**
 * QA Gate Real E2E Test
 *
 * Validates the vibe-admiral orchestration flow using a toy project:
 *  1. Reset toy project to clean state
 *  2. Start Engine on a dedicated port
 *  3. Connect via WebSocket
 *  4. Create Fleet → Send Bridge message → Ships sortie
 *  5. Wait for all Ships to reach "done"
 *  6. Verify GitHub state (issues closed, PRs exist)
 *  7. Cleanup
 *
 * Exit code 0 = PASS, non-zero = FAIL.
 * Designed to be run by Bridge sub-agent during real-e2e gate checks.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const TSX_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");

const execFileAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────

const ENGINE_PORT = 9798; // Different from real-e2e.test.ts (9799) to avoid conflicts
const WS_URL = `ws://127.0.0.1:${ENGINE_PORT}`;
const REPO = "mizunowanko-org/toy-admiral-test";
const REPO_LOCAL_PATH = `${process.env.HOME}/Projects/Development/toy-admiral-test`;
const EXPECTED_ISSUES = [1, 3];
const TOTAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min overall
const ENGINE_STARTUP_MS = 3_000;

const FLEET_NAME = "QA Gate E2E Fleet";
const FLEETS_FILE = join(process.env.HOME ?? "~", ".vibe-admiral", "fleets.json");

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

async function purgeTestFleets(): Promise<void> {
  try {
    const raw = await readFile(FLEETS_FILE, "utf-8");
    const fleets = JSON.parse(raw) as Array<{ name: string }>;
    const filtered = fleets.filter((f) => f.name !== FLEET_NAME);
    if (filtered.length < fleets.length) {
      await writeFile(FLEETS_FILE, JSON.stringify(filtered, null, 2));
      log(`Purged ${fleets.length - filtered.length} leftover QA gate fleet(s)`);
    }
  } catch {
    // File doesn't exist or is unreadable
  }
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[qa-e2e][${ts}] ${msg}`);
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

// ── Step 1.5: Kill stale processes on the test port ─────────────────

function killPortProcess(port: number): void {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf-8",
    }).trim();
    if (out) {
      const pids = out.split("\n").filter(Boolean);
      for (const pid of pids) {
        log(`Killing stale process on port ${port}: pid ${pid}`);
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Process may have already exited
        }
      }
      // Brief wait for OS to release the port
      execFileSync("sleep", ["1"]);
    }
  } catch {
    // lsof returns non-zero when no process found — that's fine
  }
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

async function createFleet(ws: WebSocket): Promise<string> {
  log("Creating fleet...");
  send(ws, {
    type: "fleet:create",
    data: { name: FLEET_NAME, repos: [{ localPath: REPO_LOCAL_PATH }] },
  });

  const fleetMsg = await waitForMessage(
    ws,
    (m) => m.type === "fleet:created",
    10_000,
    "fleet:created",
  );
  const fleetId = fleetMsg.data!.id as string;
  log(`Fleet created: ${fleetId}`);
  return fleetId;
}

async function runTest(ws: WebSocket, fleetId: string): Promise<void> {
  const ships = new Map<string, ShipInfo>();
  const doneShips = new Set<string>();
  const errorShips = new Set<string>();

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
          }
          break;
        }
        case "bridge:stream": {
          const d = msg.data!;
          const message = d.message as Record<string, unknown>;
          const type = message.type as string;
          const content = (message.content as string) ?? "";
          if (type === "assistant" && content) {
            const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
            log(`Bridge: ${preview}`);
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

  // Send Bridge command to sortie all todo issues
  log("Sending Bridge command...");
  send(ws, {
    type: "bridge:send",
    data: {
      fleetId,
      message:
        "List all todo issues in the fleet repos and sortie all unblocked ones immediately. Do not ask for confirmation.",
    },
  });

  // Wait for ships to be created and complete
  log("Waiting for ships to be created and complete...");

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

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

  // Verify results
  log("\n=== QA GATE E2E RESULTS ===");
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
}

// ── Step 6: Verify GitHub state ─────────────────────────────────────

async function verifyGitHubState(): Promise<void> {
  for (const issueNum of EXPECTED_ISSUES) {
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

  const wtRaw = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: REPO_LOCAL_PATH },
  );
  const worktrees = wtRaw.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.replace("worktree ", ""));
  const extraWorktrees = worktrees.filter((w) => w !== REPO_LOCAL_PATH);
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
    // Step 0: Purge leftover test fleets
    await purgeTestFleets();

    // Step 1: Reset toy project
    await resetToyProject();

    // Step 1.5: Kill stale processes on the test port
    killPortProcess(ENGINE_PORT);

    // Step 2: Start engine
    engine = startEngine();
    await sleep(ENGINE_STARTUP_MS);

    // Step 3: Connect
    ws = await connectWithRetry();

    // Step 4a: Create fleet
    fleetId = await createFleet(ws);

    // Steps 4b-6: Run test
    await runTest(ws, fleetId);
  } catch (err) {
    console.error(
      "\nQA Gate E2E test failed:",
      err instanceof Error ? err.message : err,
    );
    exitCode = 1;
  } finally {
    // Cleanup
    log("Cleaning up...");

    let wsCleanupOk = false;
    if (fleetId && ws && ws.readyState === WebSocket.OPEN) {
      log(`Deleting QA gate fleet ${fleetId}...`);
      try {
        send(ws, { type: "fleet:delete", data: { id: fleetId } });
        await waitForMessage(ws, (m) => m.type === "fleet:data", 5_000, "fleet:data");
        log("QA gate fleet deleted.");
        wsCleanupOk = true;
      } catch {
        log("Warning: WS-based fleet delete failed.");
      }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    if (engine && !engine.killed) {
      engine.kill("SIGTERM");
      await sleep(2_000);
      if (!engine.killed) {
        engine.kill("SIGKILL");
      }
    }

    if (!wsCleanupOk) {
      await purgeTestFleets();
    }
    log("Done.");
  }

  process.exit(exitCode);
}

main();
