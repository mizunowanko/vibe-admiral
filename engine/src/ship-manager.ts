import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProcessManager } from "./process-manager.js";
import { AcceptanceWatcher } from "./acceptance-watcher.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, ShipStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export class ShipManager {
  private ships = new Map<string, ShipProcess>();
  private processManager: ProcessManager;
  private acceptanceWatcher: AcceptanceWatcher;
  private onStatusChange:
    | ((id: string, status: ShipStatus, detail?: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    acceptanceWatcher: AcceptanceWatcher,
  ) {
    this.processManager = processManager;
    this.acceptanceWatcher = acceptanceWatcher;
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
      this.onStatusChange?.(id, status, detail);
    }
  }

  updatePhaseFromStream(
    id: string,
    msg: Record<string, unknown>,
  ): void {
    // Detect phase from stream-json output patterns
    const type = msg.type as string | undefined;
    const content = (msg.content as string) ?? "";
    const tool = (msg.tool as string) ?? "";

    if (type === "assistant") {
      if (content.includes("EnterPlanMode") || tool === "EnterPlanMode") {
        this.updateStatus(id, "planning");
      } else if (content.includes("ExitPlanMode") || tool === "ExitPlanMode") {
        this.updateStatus(id, "implementing");
      }
    }

    if (type === "tool_use" || type === "tool_result") {
      if (tool === "Edit" || tool === "Write") {
        this.updateStatus(id, "implementing");
      } else if (tool === "Bash") {
        const toolInput = msg.input as string | undefined;
        if (toolInput?.includes("npm test") || toolInput?.includes("vitest")) {
          this.updateStatus(id, "testing");
        } else if (
          toolInput?.includes("gh pr create") ||
          toolInput?.includes("gh pr merge")
        ) {
          this.updateStatus(id, "merging");
        }
      } else if (tool === "Skill" || tool === "Task") {
        if (content.includes("review-pr")) {
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

  stopAll(): void {
    for (const [id] of this.ships) {
      this.processManager.kill(id);
    }
    this.acceptanceWatcher.unwatchAll();
  }
}
