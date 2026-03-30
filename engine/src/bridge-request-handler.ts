import type { ShipManager } from "./ship-manager.js";
import type { StateSync } from "./state-sync.js";
import type { FlagshipRequest, FleetRepo, FleetSkillSources, ShipProcess } from "./types.js";

export class FlagshipRequestHandler {
  private shipManager: ShipManager;
  private stateSync: StateSync;

  constructor(shipManager: ShipManager, stateSync: StateSync) {
    this.shipManager = shipManager;
    this.stateSync = stateSync;
  }

  async handle(
    fleetId: string,
    request: FlagshipRequest,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
    maxConcurrentSorties?: number,
    customInstructionsText?: string,
  ): Promise<string> {
    switch (request.request) {
      case "sortie":
        return this.handleSortie(fleetId, request, fleetRepos, repoRemotes, skillSources, shipExtraPrompt, maxConcurrentSorties, customInstructionsText);
      case "ship-status":
        return this.handleShipStatus(fleetId);
      case "ship-pause":
        return this.handleShipPause(request);
      case "ship-resume":
        return this.handleShipResume(request, shipExtraPrompt);
      case "ship-abandon":
        return this.handleShipAbandon(request);
      case "ship-reactivate":
        return this.handleShipReactivate(request);
      case "ship-delete":
        return this.handleShipDelete(request);
      case "pr-review-result":
        return this.handlePRReviewResult(request);
      case "restart":
        return "[Restart] Use POST /api/restart endpoint directly";
    }
  }

  private async handleSortie(
    fleetId: string,
    request: Extract<FlagshipRequest, { request: "sortie" }>,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
    maxConcurrentSorties?: number,
    customInstructionsText?: string,
  ): Promise<string> {
    // Determine concurrent sortie limit (static, not dynamically adjusted)
    const configuredMax = maxConcurrentSorties ?? 6;
    const activeShips = this.shipManager.getShipsByFleet(fleetId)
      .filter((s: ShipProcess) => s.phase !== "done" && s.phase !== "paused" && s.phase !== "abandoned");
    const availableSlots = Math.max(0, configuredMax - activeShips.length);

    if (availableSlots === 0) {
      return `[Sortie Throttled] Concurrent limit reached (${activeShips.length}/${configuredMax} active). Wait for Ships to complete.`;
    }

    const repoSet = new Set(repoRemotes);
    const results: string[] = [];
    let launched = 0;

    for (const item of request.items) {
      // Check per-item concurrent limit
      if (launched >= availableSlots) {
        results.push(
          `Deferred ${item.repo}#${item.issueNumber}: concurrent limit reached (${configuredMax})`,
        );
        continue;
      }
      // Validate repo is in fleet whitelist
      if (!repoSet.has(item.repo)) {
        results.push(
          `Rejected ${item.repo}#${item.issueNumber}: repo not registered in this fleet`,
        );
        continue;
      }

      // Run sortie guard
      const guard = await this.stateSync.sortieGuard(item.repo, item.issueNumber);
      if (!guard.ok) {
        results.push(
          `Blocked ${item.repo}#${item.issueNumber}: ${guard.reason}`,
        );
        continue;
      }

      // Append non-blocking file overlap warnings (informational only)
      if (guard.warnings?.length) {
        for (const warning of guard.warnings) {
          results.push(`⚠️ ${item.repo}#${item.issueNumber}: ${warning}`);
        }
      }

      // Find local path
      const repoEntry = fleetRepos.find(
        (r) => r.remote === item.repo || r.localPath === item.repo,
      );
      if (!repoEntry) {
        results.push(
          `Failed ${item.repo}#${item.issueNumber}: no local path registered`,
        );
        continue;
      }

      try {
        const ship = await this.shipManager.sortie(
          fleetId,
          item.repo,
          item.issueNumber,
          repoEntry.localPath,
          skillSources,
          shipExtraPrompt,
          item.skill,
          customInstructionsText,
        );
        launched++;
        results.push(
          `Ship ${ship.id} launched for ${item.repo}#${item.issueNumber} (${ship.issueTitle})`,
        );
      } catch (err) {
        results.push(
          `Failed ${item.repo}#${item.issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return `[Sortie Results]\n${results.join("\n")}`;
  }

  private handleShipStatus(fleetId: string): string {
    const ships = this.shipManager.getShipsByFleet(fleetId);
    if (ships.length === 0) {
      return "[Ship Status] No active ships in this fleet.";
    }
    const lines = ships.map(
      (s) =>
        `  Ship ${s.id} #${s.issueNumber} (${s.issueTitle}): ${s.phase}${s.gateCheck ? ` [gate: ${s.gateCheck.gatePhase} ${s.gateCheck.status}]` : ""}\n    Worktree: ${s.worktreePath}\n    Log: ${s.worktreePath}/.claude/ship-log.jsonl`,
    );
    return `[Ship Status]\n${lines.join("\n")}`;
  }

  private handleShipPause(
    request: Extract<FlagshipRequest, { request: "ship-pause" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Pause Ship Failed] Ship ${request.shipId} not found or already paused`;
    }
    const killed = this.shipManager.pauseShip(ship.id);
    if (killed) {
      return `[Ship Paused] ${ship.id}`;
    }
    return `[Pause Ship Failed] Ship ${request.shipId} not found or already paused`;
  }

  private handleShipResume(
    request: Extract<FlagshipRequest, { request: "ship-resume" }>,
    shipExtraPrompt?: string,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Ship Resume Failed] Ship ${request.shipId} not found`;
    }
    // Ship can be resumed if phase is not done (process death is handled by retry logic)
    if (ship.phase === "done") {
      return `[Ship Resume Failed] Ship #${ship.issueNumber} is already done`;
    }
    if (ship.phase === "abandoned") {
      return `[Ship Resume Failed] Ship #${ship.issueNumber} is abandoned. Reactivate it first.`;
    }

    const result = this.shipManager.retryShip(ship.id, shipExtraPrompt);
    if (!result) {
      return `[Ship Resume Failed] Could not resume Ship #${ship.issueNumber}`;
    }

    const method = ship.sessionId ? "session resume" : "re-sortie";
    return `[Ship Resumed] Ship #${ship.issueNumber} (${ship.issueTitle}) resumed via ${method}`;
  }

  private handleShipAbandon(
    request: Extract<FlagshipRequest, { request: "ship-abandon" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Ship Abandon Failed] Ship ${request.shipId} not found`;
    }
    const abandoned = this.shipManager.abandonShip(ship.id);
    if (abandoned) {
      return `[Ship Abandoned] Ship #${ship.issueNumber} (${ship.issueTitle}) marked as abandoned`;
    }
    return `[Ship Abandon Failed] Ship #${ship.issueNumber} is not in "paused" phase (current: ${ship.phase})`;
  }

  private handleShipReactivate(
    request: Extract<FlagshipRequest, { request: "ship-reactivate" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Ship Reactivate Failed] Ship ${request.shipId} not found`;
    }
    const reactivated = this.shipManager.reactivateShip(ship.id);
    if (reactivated) {
      return `[Ship Reactivated] Ship #${ship.issueNumber} (${ship.issueTitle}) moved from abandoned to paused`;
    }
    return `[Ship Reactivate Failed] Ship #${ship.issueNumber} is not in "abandoned" phase (current: ${ship.phase})`;
  }

  private handleShipDelete(
    request: Extract<FlagshipRequest, { request: "ship-delete" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Ship Delete Failed] Ship ${request.shipId} not found`;
    }
    const deleted = this.shipManager.deleteShip(ship.id);
    if (deleted) {
      return `[Ship Deleted] Ship #${ship.issueNumber} (${ship.issueTitle}) removed`;
    }
    return `[Ship Delete Failed] Could not delete Ship ${request.shipId}`;
  }

  private handlePRReviewResult(
    request: Extract<FlagshipRequest, { request: "pr-review-result" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[PR Review Failed] Ship ${request.shipId} not found`;
    }

    this.shipManager.respondToPRReview(ship.id, {
      verdict: request.verdict,
      comments: request.comments,
    });

    const label = request.verdict === "approve" ? "APPROVED" : "CHANGES REQUESTED";
    return `[PR Review Result] Ship #${ship.issueNumber} PR #${request.prNumber}: ${label}${request.comments ? ` — ${request.comments}` : ""}`;
  }

}
