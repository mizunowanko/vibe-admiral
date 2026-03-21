import type { ShipManager } from "./ship-manager.js";
import type { ShipRequest } from "./types.js";
import * as github from "./github.js";

/** Simple ok/error response for admiral requests. */
export interface AdmiralRequestResponse {
  ok: boolean;
  error?: string;
}

/**
 * Handles admiral-request blocks from Ship processes.
 *
 * Supports:
 * - `nothing-to-do`: Ship determined there is no work to do —
 *   posts a comment on the issue, closes it, and marks the Ship as done.
 *
 * Note: `status-transition` was removed in #439. Ships now update the
 * phases table directly via sqlite3 CLI.
 *
 * Response delivery: the caller (ws-server) writes the response to the DB
 * via fleetDb.insertMessage() instead of writing files.
 */
export class ShipRequestHandler {
  private shipManager: ShipManager;

  constructor(shipManager: ShipManager) {
    this.shipManager = shipManager;
  }

  /**
   * Handle a Ship request and return a response.
   */
  async handle(
    shipId: string,
    request: ShipRequest,
  ): Promise<AdmiralRequestResponse> {
    switch (request.request) {
      case "nothing-to-do":
        return this.handleNothingToDo(shipId, request.reason);
    }
  }

  /**
   * Handle "nothing-to-do": Ship determined there is no work needed.
   * Posts a comment on the issue, closes it, and marks the Ship as done.
   */
  private async handleNothingToDo(
    shipId: string,
    reason: string,
  ): Promise<AdmiralRequestResponse> {
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
    this.shipManager.updatePhase(shipId, "done");

    return { ok: true };
  }

}
