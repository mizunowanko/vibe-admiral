/**
 * Ship Actor Manager
 *
 * Manages XState Actor instances for active Ships. Each Ship gets one Actor
 * backed by the ship-machine definition. The Actor Manager:
 *
 * - Creates actors when Ships are sortied
 * - Routes events (phase transitions, gate verdicts, process signals)
 * - Subscribes to state changes and dispatches side effects
 * - Restores actors from DB on Engine restart
 * - Provides snapshot access for API queries
 */
import { createActor, type Actor } from "xstate";
import { shipMachine, stateValueToPhase, type ShipMachineContext, type ShipMachineEvent, type ShipMachineInput } from "./ship-machine.js";
import type { Phase, GatePhase, GateType, ShipProcess } from "./types.js";

/** Side-effect handlers provided by the Engine wiring layer. */
export interface ShipActorSideEffects {
  /** Persist phase change to DB and notify frontend. */
  onPhaseChange: (shipId: string, phase: Phase, detail?: string) => void;
  /** Record a phase transition in the audit log. */
  onRecordTransition: (
    shipId: string,
    fromPhase: Phase,
    toPhase: Phase,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
  ) => void;
  /** Launch an Escort process for a gate phase. */
  onLaunchEscort: (shipId: string, gatePhase: GatePhase, gateType: GateType) => void;
}

/**
 * Events to replay from the initial "plan" state to reach each phase.
 * XState v5 always creates actors at the initial state, so we replay
 * events to advance the actor to the correct DB phase on Engine restart.
 */
const PHASE_REPLAY_EVENTS: Record<Phase, ShipMachineEvent[]> = {
  plan: [],
  "plan-gate": [{ type: "GATE_ENTER" }],
  coding: [{ type: "GATE_ENTER" }, { type: "GATE_APPROVED" }],
  "coding-gate": [{ type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }],
  qa: [{ type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }, { type: "GATE_APPROVED" }],
  "qa-gate": [{ type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }],
  merging: [{ type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }, { type: "GATE_APPROVED" }, { type: "GATE_ENTER" }, { type: "GATE_APPROVED" }],
  done: [],
  stopped: [],
};

export class ShipActorManager {
  private actors = new Map<string, Actor<typeof shipMachine>>();
  /** Ships currently being replayed — side effects are suppressed during replay. */
  private replayingShips = new Set<string>();
  private sideEffects: ShipActorSideEffects | null = null;

  setSideEffects(effects: ShipActorSideEffects): void {
    this.sideEffects = effects;
  }

  /**
   * Create and start a new Ship Actor.
   * Called when a Ship is sortied (new or re-sortied).
   */
  createActor(input: ShipMachineInput): Actor<typeof shipMachine> {
    // Stop existing actor if present (re-sortie case)
    this.stopActor(input.shipId);

    const actor = createActor(shipMachine, { input });
    this.setupSubscription(input.shipId, actor);
    actor.start();
    this.actors.set(input.shipId, actor);

    return actor;
  }

  /**
   * Restore an Actor for a Ship that was persisted in DB.
   * Replays events to advance the XState actor to the DB phase.
   * Called during Engine startup reconciliation.
   */
  restoreActor(ship: ShipProcess, phaseBeforeStopped?: Phase | null): Actor<typeof shipMachine> | null {
    // Don't restore terminal states
    if (ship.phase === "done") return null;

    // Stop existing actor if somehow present
    this.stopActor(ship.id);

    const input: ShipMachineInput = {
      shipId: ship.id,
      fleetId: ship.fleetId,
      repo: ship.repo,
      issueNumber: ship.issueNumber,
      worktreePath: ship.worktreePath,
      branchName: ship.branchName,
      sessionId: ship.sessionId,
      prUrl: ship.prUrl,
      qaRequired: ship.qaRequired,
      phaseBeforeStopped: phaseBeforeStopped ?? null,
    };

    const actor = createActor(shipMachine, { input });
    this.setupSubscription(ship.id, actor, { suppressInitial: true });
    actor.start();
    this.actors.set(ship.id, actor);

    // Replay events to advance XState to the DB phase.
    // For "stopped" ships, replay to phaseBeforeStopped then send STOP.
    const targetPhase = ship.phase as Phase;
    this.replayToPhase(ship.id, actor, targetPhase, phaseBeforeStopped ?? null);

    return actor;
  }

  /**
   * Send an event to a Ship's Actor.
   * Returns true if the event was sent, false if no actor exists.
   */
  send(shipId: string, event: ShipMachineEvent): boolean {
    const actor = this.actors.get(shipId);
    if (!actor) return false;
    actor.send(event);
    return true;
  }

  /**
   * Request a phase transition through XState. XState is the sole authority
   * for validating phase transitions — if XState rejects the event, the
   * transition is denied.
   *
   * Returns `{ success: true, fromPhase, toPhase }` if the transition occurred,
   * or `{ success: false, currentPhase }` if XState did not transition.
   */
  requestTransition(
    shipId: string,
    event: ShipMachineEvent,
  ): { success: true; fromPhase: Phase; toPhase: Phase } | { success: false; currentPhase: Phase | undefined } {
    const actor = this.actors.get(shipId);
    if (!actor) {
      return { success: false, currentPhase: undefined };
    }

    const beforePhase = this.getPhase(shipId);
    actor.send(event);
    const afterPhase = this.getPhase(shipId);

    if (afterPhase && afterPhase !== beforePhase) {
      return { success: true, fromPhase: beforePhase!, toPhase: afterPhase };
    }
    return { success: false, currentPhase: afterPhase };
  }

  /**
   * Get the current phase from the Actor's XState state.
   * After replay, the XState state matches the DB phase.
   */
  getPhase(shipId: string): Phase | undefined {
    const actor = this.actors.get(shipId);
    if (!actor) return undefined;
    const snapshot = actor.getSnapshot();
    return stateValueToPhase(snapshot.value as string);
  }

  /**
   * Get the full context from the Actor's snapshot.
   */
  getContext(shipId: string): ShipMachineContext | undefined {
    const actor = this.actors.get(shipId);
    if (!actor) return undefined;
    return actor.getSnapshot().context;
  }

  /**
   * Check if an Actor exists for a Ship.
   */
  hasActor(shipId: string): boolean {
    return this.actors.has(shipId);
  }

  /**
   * Stop and remove an Actor.
   */
  stopActor(shipId: string): void {
    const actor = this.actors.get(shipId);
    if (actor) {
      actor.stop();
      this.actors.delete(shipId);
    }
    this.replayingShips.delete(shipId);
  }

  /**
   * Stop all actors. Called during Engine shutdown.
   */
  stopAll(): void {
    for (const [, actor] of this.actors) {
      actor.stop();
    }
    this.actors.clear();
    this.replayingShips.clear();
  }

  /**
   * Get all active actor IDs.
   */
  getActiveShipIds(): string[] {
    return Array.from(this.actors.keys());
  }

  /**
   * Replay events to advance the XState actor from "plan" to the target phase.
   * Side effects are suppressed during replay.
   */
  private replayToPhase(
    shipId: string,
    actor: Actor<typeof shipMachine>,
    targetPhase: Phase,
    phaseBeforeStopped: Phase | null,
  ): void {
    // For "stopped" ships: replay to phaseBeforeStopped, then send STOP
    const replayTarget = targetPhase === "stopped" && phaseBeforeStopped
      ? phaseBeforeStopped
      : targetPhase;

    const events = PHASE_REPLAY_EVENTS[replayTarget];
    if (!events || events.length === 0) {
      if (targetPhase === "stopped") {
        // phaseBeforeStopped is "plan" or unknown — just send STOP from initial state
        this.replayingShips.add(shipId);
        actor.send({ type: "STOP" });
        this.replayingShips.delete(shipId);
      }
      return;
    }

    this.replayingShips.add(shipId);
    for (const event of events) {
      actor.send(event);
    }
    if (targetPhase === "stopped") {
      actor.send({ type: "STOP" });
    }
    this.replayingShips.delete(shipId);
  }

  /**
   * Subscribe to Actor state changes and dispatch side effects.
   * @param suppressInitial If true, suppress the initial state notification
   *   (used for restored actors where the DB phase is the source of truth).
   */
  private setupSubscription(
    shipId: string,
    actor: Actor<typeof shipMachine>,
    options?: { suppressInitial?: boolean },
  ): void {
    let previousPhase: string | null = null;
    const suppressInitial = options?.suppressInitial ?? false;

    actor.subscribe((snapshot) => {
      const currentPhase = snapshot.value as string;

      // Only dispatch on actual phase changes
      if (currentPhase === previousPhase) return;

      const isInitial = previousPhase === null;
      previousPhase = currentPhase;

      // Skip initial state notification for both new and restored actors
      if (isInitial && suppressInitial) return;
      if (isInitial) return;

      // Suppress side effects during replay (Engine restart reconciliation)
      if (this.replayingShips.has(shipId)) return;

      const phase = stateValueToPhase(currentPhase);

      // Dispatch side effects
      this.sideEffects?.onPhaseChange(shipId, phase);
    });
  }
}
