import type { ShipManager } from "./ship-manager.js";
import type {
  ShipRequest,
  Phase,
  GatePhase,
  GateType,
  FleetGateSettings,
} from "./types.js";
import { PHASE_ORDER, GATE_PREV_PHASE, GATE_NEXT_PHASE, isGatePhase } from "./types.js";
import { resolveGateType, getNextPhaseAfterGate } from "./gate-config.js";
import * as github from "./github.js";

/** Simple ok/error response for admiral requests. */
export interface AdmiralRequestResponse {
  ok: boolean;
  error?: string;
}

/**
 * Extended response that indicates whether a gate check was triggered.
 * When `gate` is set, the caller should initiate the gate check flow
 * and write the response to the DB via fleetDb.insertMessage().
 */
export interface StatusTransitionResult extends AdmiralRequestResponse {
  gate?: {
    type: GateType;
    gatePhase: GatePhase;
    /** The work phase to advance to after gate approval. */
    targetPhase: Phase;
    /** Feedback from the previous rejected gate check (for retry awareness). */
    previousFeedback?: string;
  };
}

/**
 * Find the gate phase that sits between the current work phase and its target.
 * Returns undefined if the current phase doesn't map to any gate.
 */
function findGatePhaseForWorkPhase(currentPhase: Phase): GatePhase | undefined {
  for (const [gatePhase, prevPhase] of Object.entries(GATE_PREV_PHASE)) {
    if (prevPhase === currentPhase) {
      return gatePhase as GatePhase;
    }
  }
  return undefined;
}

/**
 * Handles admiral-request blocks from Ship processes.
 *
 * Supports:
 * - `status-transition`: Phase-model transition —
 *   Ship requests a target work phase, Engine determines if a gate phase
 *   is needed first, checks gate settings/state, and advances accordingly.
 * - `nothing-to-do`: Ship determined there is no work to do —
 *   posts a comment on the issue, closes it, and marks the Ship as done.
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

  /**
   * Phase-model transition handler.
   *
   * 1. Ship requests target phase (e.g. "implementing")
   * 2. Map from current work phase to the gate phase that precedes the target:
   *    - planning → planning-gate (to go to implementing)
   *    - implementing → implementing-gate (to go to acceptance-test)
   *    - acceptance-test → acceptance-test-gate (to go to merging)
   * 3. Check if gate is enabled for that gate phase via resolveGateType()
   * 4. If gate enabled:
   *    - Check if ship is already in the gate phase:
   *      - approved: advance to target work phase
   *      - pending: return "waiting for approval"
   *      - rejected: clear, return gate info for re-initiation
   *    - If not in gate phase yet: return gate info for initiation
   * 5. If gate disabled: advance directly to target work phase
   * 6. For "done": handle directly (terminal state)
   * 7. Label sync is non-blocking (failure doesn't block phase transition)
   */
  private async handleStatusTransition(
    shipId: string,
    targetPhase: Phase,
    gateSettings?: FleetGateSettings,
  ): Promise<StatusTransitionResult> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      return { ok: false, error: `Ship ${shipId} not found` };
    }

    // Handle "done" specially — it's a terminal state, not a phase label
    if (targetPhase === "done") {
      this.shipManager.updatePhase(shipId, "done");
      return { ok: true };
    }

    // Validate forward-only phase advancement
    const currentIdx = PHASE_ORDER.indexOf(ship.phase);
    const targetIdx = PHASE_ORDER.indexOf(targetPhase);

    if (targetIdx < 0) {
      return { ok: false, error: `Invalid target phase: ${targetPhase}` };
    }
    if (currentIdx < 0) {
      return { ok: false, error: `Ship in unknown phase: ${ship.phase}` };
    }
    if (targetIdx <= currentIdx) {
      return {
        ok: false,
        error: `Cannot go backward: ${ship.phase} → ${targetPhase}`,
      };
    }

    // Determine the gate phase that precedes the target work phase.
    // If the ship is currently in a gate phase (e.g. planning-gate) and requesting
    // the next work phase (e.g. implementing), check the gate state directly.
    // If the ship is in a work phase (e.g. planning), find the gate that sits between.
    let gatePhase: GatePhase | undefined;

    if (isGatePhase(ship.phase)) {
      // Ship is already in a gate phase — check if the target matches
      const expectedTarget = GATE_NEXT_PHASE[ship.phase];
      if (expectedTarget === targetPhase) {
        gatePhase = ship.phase;
      } else {
        return {
          ok: false,
          error: `Ship in gate phase ${ship.phase}, expected target ${expectedTarget} but got ${targetPhase}`,
        };
      }
    } else {
      // Ship is in a work phase — find the gate that sits between current and target
      gatePhase = findGatePhaseForWorkPhase(ship.phase);
    }

    if (gatePhase) {
      let gateType = resolveGateType(gatePhase, gateSettings);

      // Skip playwright gate when Ship determined QA is not required
      if (gateType === "playwright" && ship.qaRequired === false) {
        gateType = null;
      }

      if (gateType) {
        // Check if ship is already in this gate phase (has an active gateCheck)
        if (ship.gateCheck?.gatePhase === gatePhase) {
          if (ship.gateCheck.status === "approved") {
            // Gate was approved — clear and proceed to target work phase
            this.shipManager.clearGateCheck(shipId);
            // Fall through to advance below
          } else if (ship.gateCheck.status === "pending") {
            // Gate is still pending — tell Ship to wait
            return {
              ok: false,
              error: `Gate check pending for ${gatePhase}. Waiting for Bridge approval.`,
            };
          } else if (ship.gateCheck.status === "rejected") {
            // Gate was rejected — capture feedback, clear, return gate info for re-initiation
            const prevFeedback = ship.gateCheck.feedback;
            this.shipManager.clearGateCheck(shipId);
            return {
              ok: false,
              gate: {
                type: gateType,
                gatePhase,
                targetPhase,
                previousFeedback: prevFeedback,
              },
              error: `Gate check required for ${gatePhase}. Initiating review.`,
            };
          }
        } else {
          // Not in gate phase yet — return gate info for initiation
          return {
            ok: false,
            gate: { type: gateType, gatePhase, targetPhase },
            error: `Gate check required for ${gatePhase}. Initiating review.`,
          };
        }
      }
    }

    // No gate (or gate approved) — advance to target work phase
    // Per-phase labels abolished — only status/sortied exists (set at sortie time)
    this.shipManager.updatePhase(shipId, targetPhase);
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
    this.shipManager.updatePhase(shipId, "done");

    return { ok: true };
  }

  /**
   * Execute a transition that was previously gated and is now approved.
   * Called by the gate result handler after Bridge approves.
   *
   * Advances from gate phase to the next work phase.
   * Label sync is non-blocking (try/catch, warn on failure, don't block).
   */
  async executeGatedTransition(
    shipId: string,
    gatePhase: GatePhase,
  ): Promise<AdmiralRequestResponse> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      return { ok: false, error: `Ship ${shipId} not found` };
    }

    const targetPhase = getNextPhaseAfterGate(gatePhase);

    this.shipManager.updatePhase(shipId, targetPhase);
    return { ok: true };
  }

}
