import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipManager } from "./ship-manager.js";
import type { StatusManager } from "./status-manager.js";
import type { ShipRequest, AdmiralRequestResponse, ShipStatus } from "./types.js";

/**
 * Handles admiral-request blocks from Ship processes.
 *
 * Currently supports:
 * - `status-transition`: Transactional phase change —
 *   validates the transition, updates GitHub label synchronously,
 *   and only then confirms the new status internally.
 */
export class ShipRequestHandler {
  private shipManager: ShipManager;
  private statusManager: StatusManager;

  constructor(shipManager: ShipManager, statusManager: StatusManager) {
    this.shipManager = shipManager;
    this.statusManager = statusManager;
  }

  /**
   * Handle a Ship request and return a response to write back.
   * The caller is responsible for writing the response file.
   */
  async handle(
    shipId: string,
    request: ShipRequest,
  ): Promise<AdmiralRequestResponse> {
    switch (request.request) {
      case "status-transition":
        return this.handleStatusTransition(shipId, request.status);
    }
  }

  private async handleStatusTransition(
    shipId: string,
    targetStatus: ShipStatus,
  ): Promise<AdmiralRequestResponse> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      return { ok: false, error: `Ship ${shipId} not found` };
    }

    // Handle "done" specially — it's a terminal state, not a phase label
    if (targetStatus === "done") {
      this.shipManager.updateStatus(shipId, "done");
      return { ok: true };
    }

    // Validate forward-only phase advancement
    const phaseOrder: ShipStatus[] = [
      "sortie", "investigating", "planning", "implementing",
      "testing", "reviewing", "acceptance-test", "merging",
    ];
    const currentIdx = phaseOrder.indexOf(ship.status);
    const targetIdx = phaseOrder.indexOf(targetStatus);

    if (targetIdx < 0) {
      return { ok: false, error: `Invalid target status: ${targetStatus}` };
    }
    if (targetIdx <= currentIdx) {
      return {
        ok: false,
        error: `Cannot go backward: ${ship.status} → ${targetStatus}`,
      };
    }

    // Gate: block advancement past reviewing until Bridge approves PR
    const mergingIdx = phaseOrder.indexOf("merging");
    if (targetIdx >= mergingIdx && ship.prReviewStatus !== "approved") {
      return {
        ok: false,
        error: `Cannot advance to ${targetStatus}: PR review not approved (current: ${ship.prReviewStatus ?? "none"})`,
      };
    }

    // Gate: block advancement past acceptance-test until human approves
    const acceptanceIdx = phaseOrder.indexOf("acceptance-test");
    if (targetIdx > acceptanceIdx && !ship.acceptanceTestApproved) {
      return {
        ok: false,
        error: `Cannot advance past acceptance-test: not yet approved`,
      };
    }

    // Transactional: sync GitHub label FIRST, then update internal state
    try {
      await this.statusManager.syncPhaseLabel(
        ship.repo,
        ship.issueNumber,
        targetStatus,
      );
    } catch (err) {
      return {
        ok: false,
        error: `GitHub label sync failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Label update succeeded — now confirm the status internally
    this.shipManager.updateStatus(shipId, targetStatus);
    return { ok: true };
  }

  /**
   * Write the response file so Ship can poll for the result.
   */
  static async writeResponse(
    worktreePath: string,
    response: AdmiralRequestResponse,
  ): Promise<void> {
    const claudeDir = join(worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "admiral-request-response.json"),
      JSON.stringify(response, null, 2),
    );
  }
}
