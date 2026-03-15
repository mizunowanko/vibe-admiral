import type { ShipManager } from "./ship-manager.js";
import type { StateSync } from "./state-sync.js";
import type { BridgeRequest, FleetRepo, FleetSkillSources } from "./types.js";

export class BridgeRequestHandler {
  private shipManager: ShipManager;
  private stateSync: StateSync;

  constructor(shipManager: ShipManager, stateSync: StateSync) {
    this.shipManager = shipManager;
    this.stateSync = stateSync;
  }

  async handle(
    fleetId: string,
    request: BridgeRequest,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
  ): Promise<string> {
    switch (request.request) {
      case "sortie":
        return this.handleSortie(fleetId, request, fleetRepos, repoRemotes, skillSources, shipExtraPrompt);
      case "ship-status":
        return this.handleShipStatus(fleetId);
      case "ship-stop":
        return this.handleShipStop(request);
      case "pr-review-result":
        return this.handlePRReviewResult(request);
    }
  }

  private async handleSortie(
    fleetId: string,
    request: Extract<BridgeRequest, { request: "sortie" }>,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
  ): Promise<string> {
    const repoSet = new Set(repoRemotes);
    const results: string[] = [];

    for (const item of request.items) {
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
        );
        results.push(
          `Ship ${ship.id.slice(0, 8)}... launched for ${item.repo}#${item.issueNumber} (${ship.issueTitle})`,
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
        `  Ship ${s.id.slice(0, 8)}... #${s.issueNumber} (${s.issueTitle}): ${s.status}`,
    );
    return `[Ship Status]\n${lines.join("\n")}`;
  }

  private handleShipStop(
    request: Extract<BridgeRequest, { request: "ship-stop" }>,
  ): string {
    const killed = this.shipManager.stopShip(request.shipId);
    if (killed) {
      return `[Ship Stopped] ${request.shipId}`;
    }
    return `[Stop Ship Failed] Ship ${request.shipId} not found or already stopped`;
  }

  private handlePRReviewResult(
    request: Extract<BridgeRequest, { request: "pr-review-result" }>,
  ): string {
    const ship = this.shipManager.getShip(request.shipId);
    if (!ship) {
      return `[PR Review Failed] Ship ${request.shipId} not found`;
    }

    this.shipManager.respondToPRReview(request.shipId, {
      verdict: request.verdict,
      comments: request.comments,
    });

    const label = request.verdict === "approve" ? "APPROVED" : "CHANGES REQUESTED";
    return `[PR Review Result] Ship #${ship.issueNumber} PR #${request.prNumber}: ${label}${request.comments ? ` — ${request.comments}` : ""}`;
  }
}
