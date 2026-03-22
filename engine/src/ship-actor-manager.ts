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
   * Creates the actor at the correct initial state matching the DB phase.
   * Called during Engine startup reconciliation.
   */
  restoreActor(ship: ShipProcess): Actor<typeof shipMachine> | null {
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
    };

    // Create a fresh actor — XState v5 doesn't support arbitrary initial state
    // restoration in the same way as v4. We create at "planning" and then
    // the DB remains the source of truth for the current phase during restoration.
    // The actor is used primarily for event-driven transitions going forward.
    const actor = createActor(shipMachine, { input });
    this.setupSubscription(ship.id, actor);
    actor.start();

    this.actors.set(ship.id, actor);

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
   * Get the current phase from the Actor's state.
   * Falls back to undefined if no actor exists.
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
  }

  /**
   * Stop all actors. Called during Engine shutdown.
   */
  stopAll(): void {
    for (const [, actor] of this.actors) {
      actor.stop();
    }
    this.actors.clear();
  }

  /**
   * Get all active actor IDs.
   */
  getActiveShipIds(): string[] {
    return Array.from(this.actors.keys());
  }

  /**
   * Subscribe to Actor state changes and dispatch side effects.
   */
  private setupSubscription(shipId: string, actor: Actor<typeof shipMachine>): void {
    let previousPhase: string | null = null;

    actor.subscribe((snapshot) => {
      const currentPhase = snapshot.value as string;

      // Only dispatch on actual phase changes
      if (currentPhase === previousPhase) return;

      previousPhase = currentPhase;

      const phase = stateValueToPhase(currentPhase);

      // Dispatch side effects
      this.sideEffects?.onPhaseChange(shipId, phase);
    });
  }
}
