import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProcessManager } from "./process-manager.js";
import { AcceptanceWatcher } from "./acceptance-watcher.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, ShipStatus } from "./types.js";

const execFileAsync = promisify(execFile);

const SHIP_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ShipManager {
  private ships = new Map<string, ShipProcess>();
  private processManager: ProcessManager;
  private acceptanceWatcher: AcceptanceWatcher;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange:
    | ((id: string, status: ShipStatus, detail?: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    acceptanceWatcher: AcceptanceWatcher,
  ) {
    this.processManager = processManager;
    this.acceptanceWatcher = acceptanceWatcher;
    this.startCleanup();
  }

  setStatusChangeHandler(
    handler: (id: string, status: ShipStatus, detail?: string) => void,
  ): void {
    this.onStatusChange = handler;
  }

  async sortie(
    fleetId: string,
    repo: string,
    issueNumber: number,
  ): Promise<ShipProcess> {
    const shipId = randomUUID();

    // 1. Get issue info
    const issue = await github.getIssue(repo, issueNumber);
    if (issue.labels.includes("doing")) {
      throw new Error(`Issue #${issueNumber} is already in progress (doing)`);
    }

    // 2. Update labels: todo → doing
    await github.updateLabels(repo, issueNumber, {
      remove: "todo",
      add: "doing",
    });

    // 3. Create worktree
    const localRepoPath = await this.findLocalRepo(repo);
    const repoRoot = await worktree.getRepoRoot(localRepoPath);
    const defaultBranch = await github.getDefaultBranch(repo);
    const slug = worktree.toKebabCase(issue.title);
    const branchName = `feature/${issueNumber}-${slug}`;
    const worktreePath = `${repoRoot}/.worktrees/feature/${issueNumber}-${slug}`;

    await worktree.create(worktreePath, branchName, defaultBranch);

    // 4. Symlink settings
    await worktree.symlinkSettings(repoRoot, worktreePath);

    // 5. npm install if web project
    if (await worktree.isWebProject(worktreePath)) {
      await execFileAsync("npm", ["install"], { cwd: worktreePath });
    }

    const ship: ShipProcess = {
      id: shipId,
      fleetId,
      repo,
      issueNumber,
      issueTitle: issue.title,
      status: "sortie",
      branchName,
      worktreePath,
      sessionId: null,
      prUrl: null,
      acceptanceTest: null,
      createdAt: new Date().toISOString(),
    };
    this.ships.set(shipId, ship);

    // 6. Launch Claude CLI process
    this.processManager.sortie(shipId, worktreePath, issueNumber);

    // 7. Start acceptance test watcher
    this.acceptanceWatcher.watch(worktreePath, shipId);

    this.updateStatus(shipId, "investigating");
    return ship;
  }

  async onShipComplete(shipId: string): Promise<void> {
    const ship = this.ships.get(shipId);
    if (!ship) return;

    try {
      // 1. Remove worktree
      await worktree.remove(ship.worktreePath);

      // 2. Close issue + remove label
      await github.closeIssue(ship.repo, ship.issueNumber);
      await github.updateLabels(ship.repo, ship.issueNumber, {
        remove: "doing",
      });

      // 3. Stop watcher
      this.acceptanceWatcher.unwatch(shipId);

      // 4. Update status
      this.updateStatus(shipId, "done");
    } catch (err) {
      console.error(`Error in ship completion cleanup for ${shipId}:`, err);
      this.updateStatus(shipId, "error", String(err));
    }
  }

  stopShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      this.acceptanceWatcher.unwatch(shipId);
      this.updateStatus(shipId, "error", "Manually stopped");
    }
    return killed;
  }

  getShip(shipId: string): ShipProcess | undefined {
    return this.ships.get(shipId);
  }

  getShipsByFleet(fleetId: string): ShipProcess[] {
    return Array.from(this.ships.values()).filter(
      (s) => s.fleetId === fleetId,
    );
  }

  getAllShips(): ShipProcess[] {
    return Array.from(this.ships.values());
  }

  updateStatus(id: string, status: ShipStatus, detail?: string): void {
    const ship = this.ships.get(id);
    if (ship) {
      ship.status = status;
      if (status === "done" || status === "error") {
        ship.completedAt = Date.now();
      }
      this.onStatusChange?.(id, status, detail);
    }
  }

  updatePhaseFromStream(
    id: string,
    msg: { type: string; content?: string; tool?: string; toolInput?: Record<string, unknown> },
  ): void {
    // Detect phase from parsed stream message
    const type = msg.type;
    const content = msg.content ?? "";
    const tool = msg.tool ?? "";

    if (type === "assistant") {
      if (content.includes("EnterPlanMode")) {
        this.updateStatus(id, "planning");
      } else if (content.includes("ExitPlanMode")) {
        this.updateStatus(id, "implementing");
      }
    }

    if (type === "tool_use") {
      if (tool === "EnterPlanMode") {
        this.updateStatus(id, "planning");
      } else if (tool === "ExitPlanMode") {
        this.updateStatus(id, "implementing");
      } else if (tool === "Edit" || tool === "Write") {
        this.updateStatus(id, "implementing");
      } else if (tool === "Bash") {
        const inputStr = msg.toolInput
          ? JSON.stringify(msg.toolInput)
          : "";
        if (inputStr.includes("npm test") || inputStr.includes("vitest")) {
          this.updateStatus(id, "testing");
        } else if (
          inputStr.includes("gh pr create") ||
          inputStr.includes("gh pr merge")
        ) {
          this.updateStatus(id, "merging");
        }
      } else if (tool === "Skill" || tool === "Task") {
        const inputStr = msg.toolInput
          ? JSON.stringify(msg.toolInput)
          : content;
        if (inputStr.includes("review-pr")) {
          this.updateStatus(id, "reviewing");
        }
      }
    }
  }

  respondToAcceptanceTest(
    shipId: string,
    accepted: boolean,
    feedback?: string,
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;

    this.acceptanceWatcher
      .respond(ship.worktreePath, { accepted, feedback })
      .catch((err) => {
        console.error(
          `Failed to write acceptance test response for ${shipId}:`,
          err,
        );
      });
  }

  private async findLocalRepo(repo: string): Promise<string> {
    // Try common development directory patterns
    const repoName = repo.split("/").pop() ?? repo;
    const candidates = [
      `${process.env.HOME}/Projects/Development/${repoName}`,
      `${process.env.HOME}/projects/${repoName}`,
      `${process.env.HOME}/dev/${repoName}`,
      `${process.env.HOME}/${repoName}`,
    ];

    for (const candidate of candidates) {
      try {
        await worktree.getRepoRoot(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    throw new Error(
      `Could not find local clone of ${repo}. Searched: ${candidates.join(", ")}`,
    );
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ship] of this.ships) {
        if (
          ship.completedAt &&
          now - ship.completedAt > SHIP_RETENTION_MS
        ) {
          this.ships.delete(id);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  stopAll(): void {
    this.stopCleanup();
    for (const [id] of this.ships) {
      this.processManager.kill(id);
    }
    this.acceptanceWatcher.unwatchAll();
  }
}
