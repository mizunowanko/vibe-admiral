import type { ShipManager } from "./ship-manager.js";
import type { ShipRequestHandler } from "./ship-request-handler.js";
import type { StateSync } from "./state-sync.js";
import type { BridgeRequest, FleetRepo, FleetSkillSources, GateTransition, ShipProcess } from "./types.js";
import { parseTransition } from "./gate-config.js";

export class BridgeRequestHandler {
  private shipManager: ShipManager;
  private stateSync: StateSync;
  private shipRequestHandler: ShipRequestHandler | null = null;
  private onGateApproved:
    | ((shipId: string, transition: GateTransition) => void)
    | null = null;
  private onGateRejected:
    | ((shipId: string, transition: GateTransition, feedback?: string) => void)
    | null = null;

  constructor(shipManager: ShipManager, stateSync: StateSync) {
    this.shipManager = shipManager;
    this.stateSync = stateSync;
  }

  setShipRequestHandler(handler: ShipRequestHandler): void {
    this.shipRequestHandler = handler;
  }

  setGateApprovedHandler(
    handler: (shipId: string, transition: GateTransition) => void,
  ): void {
    this.onGateApproved = handler;
  }

  setGateRejectedHandler(
    handler: (shipId: string, transition: GateTransition, feedback?: string) => void,
  ): void {
    this.onGateRejected = handler;
  }

  async handle(
    fleetId: string,
    request: BridgeRequest,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
    maxConcurrentSorties?: number,
  ): Promise<string> {
    switch (request.request) {
      case "sortie":
        return this.handleSortie(fleetId, request, fleetRepos, repoRemotes, skillSources, shipExtraPrompt, maxConcurrentSorties);
      case "ship-status":
        return this.handleShipStatus(fleetId);
      case "ship-stop":
        return this.handleShipStop(request);
      case "pr-review-result":
        return this.handlePRReviewResult(request);
      case "gate-result":
        return this.handleGateResult(request);
      case "gate-ack":
        return this.handleGateAck(request);
    }
  }

  private async handleSortie(
    fleetId: string,
    request: Extract<BridgeRequest, { request: "sortie" }>,
    fleetRepos: FleetRepo[],
    repoRemotes: string[],
    skillSources?: FleetSkillSources,
    shipExtraPrompt?: string,
    maxConcurrentSorties?: number,
  ): Promise<string> {
    // Determine concurrent sortie limit (static, not dynamically adjusted)
    const configuredMax = maxConcurrentSorties ?? 6;
    const activeShips = this.shipManager.getShipsByFleet(fleetId)
      .filter((s: ShipProcess) => s.status !== "done" && s.status !== "error");
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
        `  Ship ${s.id} #${s.issueNumber} (${s.issueTitle}): ${s.status}${s.gateCheck ? ` [gate: ${s.gateCheck.transition} ${s.gateCheck.status}]` : ""}\n    Worktree: ${s.worktreePath}\n    Log: ${s.worktreePath}/.claude/ship-log.jsonl`,
    );
    return `[Ship Status]\n${lines.join("\n")}`;
  }

  private handleShipStop(
    request: Extract<BridgeRequest, { request: "ship-stop" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId);
    if (!ship) {
      return `[Stop Ship Failed] Ship ${request.shipId} not found or already stopped`;
    }
    const killed = this.shipManager.stopShip(ship.id);
    if (killed) {
      return `[Ship Stopped] ${ship.id}`;
    }
    return `[Stop Ship Failed] Ship ${request.shipId} not found or already stopped`;
  }

  private handlePRReviewResult(
    request: Extract<BridgeRequest, { request: "pr-review-result" }>,
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

  private handleGateAck(
    request: Extract<BridgeRequest, { request: "gate-ack" }>,
  ): string {
    const ship = this.shipManager.resolveShip(request.shipId, request.issueNumber);
    if (!ship) {
      return `[Gate ACK Failed] Ship ${request.shipId} not found`;
    }

    if (!ship.gateCheck || ship.gateCheck.transition !== request.transition) {
      return `[Gate ACK Failed] Ship #${ship.issueNumber} has no pending gate for ${request.transition}`;
    }

    if (ship.gateCheck.status !== "pending") {
      return `[Gate ACK Failed] Ship #${ship.issueNumber} gate for ${request.transition} is already ${ship.gateCheck.status}`;
    }

    ship.gateCheck.acknowledgedAt = new Date().toISOString();
    console.log(
      `[bridge-request] Gate ACK received for Ship #${ship.issueNumber}: ${request.transition} — acknowledged`,
    );
    return `[Gate ACK] Ship #${ship.issueNumber}: ${request.transition} acknowledged`;
  }

  private async handleGateResult(
    request: Extract<BridgeRequest, { request: "gate-result" }>,
  ): Promise<string> {
    const ship = this.shipManager.resolveShip(request.shipId, request.issueNumber);
    if (!ship) {
      return `[Gate Result Failed] Ship ${request.shipId} not found`;
    }

    if (!ship.gateCheck || ship.gateCheck.transition !== request.transition) {
      return `[Gate Result Failed] Ship #${ship.issueNumber} has no pending gate for ${request.transition}`;
    }

    if (ship.gateCheck.status !== "pending") {
      return `[Gate Result Failed] Ship #${ship.issueNumber} gate for ${request.transition} is already ${ship.gateCheck.status}`;
    }

    const approved = request.verdict === "approve";
    await this.shipManager.respondToGate(
      ship.id,
      approved,
      request.feedback,
    );

    if (approved) {
      // Execute the gated transition
      const { to } = parseTransition(request.transition);
      if (this.shipRequestHandler) {
        const result = await this.shipRequestHandler.executeGatedTransition(
          ship.id,
          to,
        );
        if (result.ok) {
          this.onGateApproved?.(ship.id, request.transition);
          return `[Gate Approved] Ship #${ship.issueNumber}: ${request.transition} — transition confirmed`;
        }
        return `[Gate Approved but Transition Failed] Ship #${ship.issueNumber}: ${result.error}`;
      }
      return `[Gate Approved] Ship #${ship.issueNumber}: ${request.transition}`;
    }

    this.onGateRejected?.(ship.id, request.transition, request.feedback);
    return `[Gate Rejected] Ship #${ship.issueNumber}: ${request.transition}${request.feedback ? ` — ${request.feedback}` : ""}`;
  }
}
