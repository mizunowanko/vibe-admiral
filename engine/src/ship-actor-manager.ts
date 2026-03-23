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

export class ShipActorManager {
  private actors = new Map<string, Actor<typeof shipMachine>>();
  /** Tracks the effective DB phase for restored actors (Actor may be in a different XState state). */
  private effectivePhase = new Map<string, Phase>();
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
    // New actors start at "planning" — no effective phase override needed
    this.effectivePhase.delete(input.shipId);

    return actor;
  }

  /**
   * Restore an Actor for a Ship that was persisted in DB.
   * Creates the actor at the correct initial state matching the DB phase.
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

    // Create actor — XState v5 always starts at "planning" (initial state).
    // We track the effective DB phase separately to avoid spurious side effects.
    // The actor is used for event-driven transitions going forward; getPhase()
    // returns the effective phase (DB truth) rather than the Actor's XState state.
    const actor = createActor(shipMachine, { input });
    this.setupSubscription(ship.id, actor, { suppressInitial: true });
    actor.start();

    this.actors.set(ship.id, actor);
    // Store the DB phase as the effective phase — getPhase() returns this
    // instead of the Actor's XState state until a real transition occurs.
    this.effectivePhase.set(ship.id, ship.phase as Phase);

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
   * Get the current phase from the Actor's state.
   * For restored actors, returns the effective DB phase until a real
   * transition occurs through the Actor. Falls back to undefined if no actor exists.
   */
  getPhase(shipId: string): Phase | undefined {
    // Return effective phase if set (restored actors)
    const effective = this.effectivePhase.get(shipId);
    if (effective) return effective;

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
    this.effectivePhase.delete(shipId);
  }

  /**
   * Stop all actors. Called during Engine shutdown.
   */
  stopAll(): void {
    for (const [, actor] of this.actors) {
      actor.stop();
    }
    this.actors.clear();
    this.effectivePhase.clear();
  }

  /**
   * Get all active actor IDs.
   */
  getActiveShipIds(): string[] {
    return Array.from(this.actors.keys());
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

      const phase = stateValueToPhase(currentPhase);

      // When a real transition occurs on a restored actor, clear the effective
      // phase override so getPhase() starts returning the Actor's XState state.
      this.effectivePhase.delete(shipId);

      // Dispatch side effects
      this.sideEffects?.onPhaseChange(shipId, phase);
    });
  }
}
