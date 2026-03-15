import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessManager } from "./process-manager.js";
import { AcceptanceWatcher } from "./acceptance-watcher.js";
import type { StatusManager } from "./status-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import { writeFile } from "node:fs/promises";
import type { ShipProcess, ShipStatus, FleetSkillSources, PRReviewResponse } from "./types.js";

const execFileAsync = promisify(execFile);

const SHIP_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ShipManager {
  private ships = new Map<string, ShipProcess>();
  private processManager: ProcessManager;
  private acceptanceWatcher: AcceptanceWatcher;
  private statusManager: StatusManager;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange:
    | ((id: string, status: ShipStatus, detail?: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    acceptanceWatcher: AcceptanceWatcher,
    statusManager: StatusManager,
  ) {
    this.processManager = processManager;
    this.acceptanceWatcher = acceptanceWatcher;
    this.statusManager = statusManager;
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
    localPath: string,
    skillSources?: FleetSkillSources,
    extraPrompt?: string,
    skill?: string,
  ): Promise<ShipProcess> {
    const shipId = randomUUID();

    // 1. Get issue info (used later for title, slug, etc.)
    const issue = await github.getIssue(repo, issueNumber);

    // 2. Update issue status: todo → doing (via StatusManager)
    await this.statusManager.markDoing(repo, issueNumber);

    // 3. Create worktree
    const repoRoot = await worktree.getRepoRoot(localPath);
    const defaultBranch = await github.getDefaultBranch(repo);
    const slug = worktree.toKebabCase(issue.title);
    const branchName = `feature/${issueNumber}-${slug}`;
    const worktreePath = `${repoRoot}/.worktrees/feature/${issueNumber}-${slug}`;

    await worktree.create(worktreePath, branchName, defaultBranch);

    // 4. Symlink settings
    await worktree.symlinkSettings(repoRoot, worktreePath);

    // 5. Copy /implement skill to worktree
    await this.deploySkills(repoRoot, worktreePath, skillSources);

    // 6. npm install if web project
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
      prReviewStatus: null,
      acceptanceTest: null,
      acceptanceTestApproved: false,
      createdAt: new Date().toISOString(),
    };
    this.ships.set(shipId, ship);

    // 7. Launch Claude CLI process
    this.processManager.sortie(shipId, worktreePath, issueNumber, extraPrompt, skill);

    // 8. Start acceptance test watcher
    this.acceptanceWatcher.watch(worktreePath, shipId);

    this.updateStatus(shipId, "investigating");
    return ship;
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

  getShipByIssue(issueNumber: number): ShipProcess | undefined {
    for (const ship of this.ships.values()) {
      if (ship.issueNumber === issueNumber && ship.status !== "done" && ship.status !== "error") {
        return ship;
      }
    }
    return undefined;
  }

  getActiveShipIssueNumbers(): number[] {
    const numbers: number[] = [];
    for (const ship of this.ships.values()) {
      if (ship.status !== "done" && ship.status !== "error") {
        numbers.push(ship.issueNumber);
      }
    }
    return numbers;
  }

  updateStatus(id: string, status: ShipStatus, detail?: string): void {
    const ship = this.ships.get(id);
    if (ship) {
      ship.status = status;
      if (status === "done" || status === "error") {
        ship.completedAt = Date.now();
      }
      // Sync phase label to GitHub Issue (fire-and-forget for non-terminal phases)
      // Terminal statuses (done/error) are handled by StateSync
      if (status !== "done" && status !== "error") {
        this.statusManager
          .syncPhaseLabel(ship.repo, ship.issueNumber, status)
          .catch((err) => {
            console.warn(
              `[ship-manager] Failed to sync phase label for #${ship.issueNumber}: ${status}`,
              err,
            );
          });
      }
      this.onStatusChange?.(id, status, detail);
    }
  }

  updatePhaseFromStream(
    id: string,
    msg: { type: string; content?: string; tool?: string; toolInput?: Record<string, unknown> },
  ): void {
    // Phase progression order — never go backwards
    const phaseOrder: ShipStatus[] = [
      "sortie", "investigating", "planning", "implementing",
      "testing", "reviewing", "acceptance-test", "merging",
    ];
    const ship = this.ships.get(id);
    if (!ship) return;
    const currentIdx = phaseOrder.indexOf(ship.status);

    const acceptanceIdx = phaseOrder.indexOf("acceptance-test");
    const mergingIdx = phaseOrder.indexOf("merging");
    const tryAdvance = (target: ShipStatus): void => {
      const targetIdx = phaseOrder.indexOf(target);
      if (targetIdx > currentIdx) {
        // Gate: block advancement past reviewing until Bridge approves PR
        // Check if the transition crosses the reviewing→merging boundary
        if (
          targetIdx >= mergingIdx &&
          ship.prReviewStatus !== "approved"
        ) {
          return;
        }
        // Gate: block advancement past acceptance-test until human approves
        // Check if the transition crosses the acceptance-test boundary
        if (
          targetIdx > acceptanceIdx &&
          !ship.acceptanceTestApproved
        ) {
          return;
        }
        this.updateStatus(id, target);
      }
    };

    // Detect phase from parsed stream message
    const type = msg.type;
    const content = msg.content ?? "";
    const tool = msg.tool ?? "";

    if (type === "assistant") {
      if (content.includes("EnterPlanMode")) {
        tryAdvance("planning");
      } else if (content.includes("ExitPlanMode")) {
        tryAdvance("implementing");
      }
    }

    if (type === "tool_use") {
      if (tool === "EnterPlanMode") {
        tryAdvance("planning");
      } else if (tool === "ExitPlanMode") {
        tryAdvance("implementing");
      } else if (tool === "Edit" || tool === "Write") {
        tryAdvance("implementing");
      } else if (tool === "Bash") {
        const inputStr = msg.toolInput
          ? JSON.stringify(msg.toolInput)
          : "";
        if (inputStr.includes("npm test") || inputStr.includes("vitest")) {
          tryAdvance("testing");
        } else if (inputStr.includes("gh pr create")) {
          tryAdvance("reviewing");
        } else if (inputStr.includes("gh pr merge")) {
          tryAdvance("merging");
        }
      } else if (tool === "Skill" || tool === "Task") {
        const inputStr = msg.toolInput
          ? JSON.stringify(msg.toolInput)
          : content;
        if (inputStr.includes("review-pr")) {
          tryAdvance("reviewing");
        }
      }
    }
  }

  async respondToPRReview(
    shipId: string,
    response: PRReviewResponse,
  ): Promise<void> {
    const ship = this.ships.get(shipId);
    if (!ship) return;

    ship.prReviewStatus = response.verdict === "approve" ? "approved" : "changes-requested";

    // On request-changes, revert phase to implementing so Ship can fix
    if (response.verdict === "request-changes") {
      this.updateStatus(shipId, "implementing");
    }

    // Ensure .claude directory exists and write response file for Ship CLI
    const claudeDir = join(ship.worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const responseFile = join(claudeDir, "pr-review-response.json");
    await writeFile(responseFile, JSON.stringify(response, null, 2));
  }

  respondToAcceptanceTest(
    shipId: string,
    accepted: boolean,
    feedback?: string,
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;

    if (accepted) {
      ship.acceptanceTestApproved = true;
    }

    this.acceptanceWatcher
      .respond(ship.worktreePath, { accepted, feedback })
      .catch((err) => {
        console.error(
          `Failed to write acceptance test response for ${shipId}:`,
          err,
        );
      });
  }

  private async deploySkills(
    repoRoot: string,
    worktreePath: string,
    skillSources?: FleetSkillSources,
  ): Promise<void> {
    // Copy /implement skill from the main repo's skills/ (or custom path)
    const implementSrc = skillSources?.implement
      ? join(skillSources.implement, "SKILL.md")
      : join(repoRoot, "skills", "implement", "SKILL.md");
    const implementDestDir = join(worktreePath, ".claude", "skills", "implement");
    try {
      await mkdir(implementDestDir, { recursive: true });
      await copyFile(implementSrc, join(implementDestDir, "SKILL.md"));
    } catch (err) {
      console.warn(`[ship-manager] Failed to deploy /implement skill: ${err}`);
    }

    // Copy dev-shared skills if devSharedDir is configured
    const devSharedDir = skillSources?.devSharedDir;
    if (!devSharedDir) return;

    const devSharedSkills = ["review-pr", "second-opinion", "test", "refactor"];
    for (const skillName of devSharedSkills) {
      const src = join(devSharedDir, skillName, "SKILL.md");
      const destDir = join(worktreePath, ".claude", "skills", skillName);
      try {
        await mkdir(destDir, { recursive: true });
        await copyFile(src, join(destDir, "SKILL.md"));
      } catch {
        console.warn(`[ship-manager] Failed to deploy /${skillName} skill from dev-shared`);
      }
    }
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
