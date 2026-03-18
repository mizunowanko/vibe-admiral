import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipManager } from "./ship-manager.js";
import type { StatusManager } from "./status-manager.js";
import type { ShipRequest, AdmiralRequestResponse, ShipStatus, FleetGateSettings, GateType } from "./types.js";
import { resolveGate } from "./gate-config.js";
import * as github from "./github.js";

/**
 * Extended response that indicates whether a gate check was triggered.
 * When `gate` is set, the caller should NOT write the response file immediately —
 * instead, it should initiate the gate check flow and write the response later.
 */
export interface StatusTransitionResult extends AdmiralRequestResponse {
  gate?: {
    type: GateType;
    from: ShipStatus;
    to: ShipStatus;
    /** Feedback from the previous rejected gate check (for retry awareness). */
    previousFeedback?: string;
  };
}

/**
 * Handles admiral-request blocks from Ship processes.
 *
 * Supports:
 * - `status-transition`: Transactional phase change —
 *   validates the transition, checks for gate requirements,
 *   updates GitHub label synchronously, and confirms the new status internally.
 * - `nothing-to-do`: Ship determined there is no work to do —
 *   posts a comment on the issue, closes it, and marks the Ship as done.
 */
export class ShipRequestHandler {
  private shipManager: ShipManager;
  private statusManager: StatusManager;

  constructor(shipManager: ShipManager, statusManager: StatusManager) {
    this.shipManager = shipManager;
    this.statusManager = statusManager;
  }

  /**
   * Handle a Ship request and return a response.
   * For status-transition, returns StatusTransitionResult which may include gate info.
   * Gate settings are passed per-call to avoid concurrency issues across fleets.
   */
  async handle(
    shipId: string,
    request: ShipRequest,
    gateSettings?: FleetGateSettings,
  ): Promise<StatusTransitionResult> {
    switch (request.request) {
      case "status-transition":
        // Store qaRequired on Ship when transitioning to implementing
        if (request.status === "implementing" && request.qaRequired !== undefined) {
          this.shipManager.setQaRequired(shipId, request.qaRequired);
        }
        return this.handleStatusTransition(shipId, request.status, gateSettings);
      case "nothing-to-do":
        return this.handleNothingToDo(shipId, request.reason);
    }
  }

  private async handleStatusTransition(
    shipId: string,
    targetStatus: ShipStatus,
    gateSettings?: FleetGateSettings,
  ): Promise<StatusTransitionResult> {
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
      "planning", "implementing", "acceptance-test", "merging",
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

    // Check for gate on direct transition (from current → target)
    let gateType = resolveGate(ship.status, targetStatus, gateSettings);

    // Skip playwright gate when Ship determined QA is not required
    if (gateType === "playwright" && ship.qaRequired === false) {
      gateType = null;
    }

    if (gateType) {
      // If there's already a pending/approved gate for this exact transition, check it
      if (ship.gateCheck?.transition === `${ship.status}→${targetStatus}`) {
        if (ship.gateCheck.status === "approved") {
          // Gate was approved — proceed with the transition
          this.shipManager.clearGateCheck(shipId);
        } else if (ship.gateCheck.status === "pending") {
          // Gate is still pending — reject with a message
          return {
            ok: false,
            error: `Gate check pending for ${ship.status} → ${targetStatus}. Waiting for Bridge approval.`,
          };
        } else if (ship.gateCheck.status === "rejected") {
          // Gate was rejected — Ship should have acted on the feedback
          // Capture the previous feedback before clearing
          const prevFeedback = ship.gateCheck.feedback;
          // Clear the rejection and let them re-request
          this.shipManager.clearGateCheck(shipId);
          // Fall through to initiate a new gate check with previous context
          return {
            ok: false,
            gate: { type: gateType, from: ship.status, to: targetStatus, previousFeedback: prevFeedback },
            error: `Gate check required for ${ship.status} → ${targetStatus}. Initiating review.`,
          };
        }
      } else {
        // No gate check yet — initiate one
        return {
          ok: false,
          gate: { type: gateType, from: ship.status, to: targetStatus },
          error: `Gate check required for ${ship.status} → ${targetStatus}. Initiating review.`,
        };
      }
    }

    // Legacy gate: block advancement to merging until code-review gate approves
    // (safety check when the implementing→acceptance-test gate is disabled)
    const mergingIdx = phaseOrder.indexOf("merging");
    if (targetIdx >= mergingIdx && ship.prReviewStatus !== "approved") {
      const codeReviewGate = resolveGate("implementing", "acceptance-test", gateSettings);
      if (!codeReviewGate) {
        return {
          ok: false,
          error: `Cannot advance to ${targetStatus}: PR review not approved (current: ${ship.prReviewStatus ?? "none"})`,
        };
      }
    }

    // Legacy gate: block advancement past acceptance-test until QA approved
    // (safety check when the acceptance-test→merging gate is disabled)
    const acceptanceIdx = phaseOrder.indexOf("acceptance-test");
    if (targetIdx > acceptanceIdx && !ship.acceptanceTestApproved) {
      const acceptanceGate = resolveGate("acceptance-test", "merging", gateSettings);
      if (!acceptanceGate) {
        return {
          ok: false,
          error: `Cannot advance past acceptance-test: not yet approved`,
        };
      }
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
   * Handle "nothing-to-do": Ship determined there is no work needed.
   * Posts a comment on the issue, closes it, and marks the Ship as done.
   */
  private async handleNothingToDo(
    shipId: string,
    reason: string,
  ): Promise<StatusTransitionResult> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      return { ok: false, error: `Ship ${shipId} not found` };
    }

    // Post a comment explaining why there's nothing to do
    try {
      await github.commentOnIssue(
        ship.repo,
        ship.issueNumber,
        `## Nothing to do\n\n${reason}\n\nClosing this issue as the problem appears to be already resolved.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
      );
    } catch (err) {
      console.warn(
        `[ship-request-handler] Failed to comment on #${ship.issueNumber}:`,
        err,
      );
    }

    // Close the issue
    try {
      await github.closeIssue(ship.repo, ship.issueNumber);
    } catch (err) {
      console.warn(
        `[ship-request-handler] Failed to close #${ship.issueNumber}:`,
        err,
      );
    }

    // Mark Ship as done with nothingToDo flag
    this.shipManager.setNothingToDo(shipId, reason);
    this.shipManager.updateStatus(shipId, "done");

    return { ok: true };
  }

  /**
   * Execute a transition that was previously gated and is now approved.
   * Called by the gate result handler after Bridge approves.
   */
  async executeGatedTransition(
    shipId: string,
    targetStatus: ShipStatus,
  ): Promise<AdmiralRequestResponse> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      return { ok: false, error: `Ship ${shipId} not found` };
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
