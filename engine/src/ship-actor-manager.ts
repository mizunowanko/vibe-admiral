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

type PersistedSnapshot = ReturnType<Actor<typeof shipMachine>["getPersistedSnapshot"]>;

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
  paused: [],
  abandoned: [],
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
   *
   * @param startPhase If provided (re-sortie), replay events to advance the
   *   actor to this phase. Side effects are suppressed during replay so that
   *   intermediate gate phases don't trigger Escort launches.
   */
  createActor(input: ShipMachineInput, startPhase?: Phase): Actor<typeof shipMachine> {
    // Stop existing actor if present (re-sortie case)
    this.stopActor(input.shipId);

    const actor = createActor(shipMachine, { input });
    const needsReplay = startPhase && startPhase !== "plan";
    this.setupSubscription(input.shipId, actor);
    actor.start();
    this.actors.set(input.shipId, actor);

    if (needsReplay) {
      this.replayToPhase(input.shipId, actor, startPhase, null);
    }

    return actor;
  }

  /**
   * Restore an Actor for a Ship that was persisted in DB.
   * Uses snapshot-based restoration (ADR-0017) when a persisted snapshot is available,
   * falling back to event replay for legacy Ships without snapshots.
   * Called during Engine startup reconciliation.
   */
  restoreActor(ship: ShipProcess, phaseBeforeStopped?: Phase | null, persistedSnapshot?: unknown): Actor<typeof shipMachine> | null {
    // Don't restore terminal states
    if (ship.phase === "done") return null;

    // Stop existing actor if somehow present
    this.stopActor(ship.id);

    // Build input for XState (required even when restoring from snapshot)
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

    // ADR-0017: Snapshot-based restoration (O(1), no replay needed)
    if (persistedSnapshot) {
      try {
        const actor = createActor(shipMachine, {
          input,
          snapshot: persistedSnapshot as PersistedSnapshot,
        });
        this.setupSubscription(ship.id, actor);
        actor.start();
        this.actors.set(ship.id, actor);

        // Verify snapshot restoration matches DB phase
        const restoredPhase = this.getPhase(ship.id);
        if (restoredPhase === (ship.phase as Phase)) {
          console.log(
            `[ship-actor-manager] Restored Ship ${ship.id.slice(0, 8)}... from snapshot (phase=${restoredPhase})`,
          );
          return actor;
        }

        // Snapshot/DB mismatch — fall through to replay
        console.warn(
          `[ship-actor-manager] Snapshot/DB phase mismatch for Ship ${ship.id.slice(0, 8)}...: ` +
          `snapshot=${restoredPhase}, DB=${ship.phase} — falling back to replay`,
        );
        this.stopActor(ship.id);
      } catch (err) {
        console.warn(
          `[ship-actor-manager] Snapshot restoration failed for Ship ${ship.id.slice(0, 8)}... — falling back to replay:`,
          err,
        );
        this.stopActor(ship.id);
      }
    }

    // Fallback: replay-based restoration (legacy Ships without snapshots)
    const actor = createActor(shipMachine, { input });
    this.setupSubscription(ship.id, actor);
    actor.start();
    this.actors.set(ship.id, actor);

    // Replay events to advance XState to the DB phase.
    // For "paused" ships, replay to phaseBeforeStopped then send PAUSE.
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
    // Log rejected transitions for debugging (#839).
    // XState silently ignores events that are not handled in the current state.
    console.warn(
      `[ship-actor] Transition rejected: event=${event.type} phase=${afterPhase ?? "unknown"} ` +
      `shipId=${shipId.slice(0, 8)}...`,
    );
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
   * Get the raw XState snapshot for dry-run transitions (ADR-0021).
   * Used by PhaseTransactionService to validate transitions without side effects.
   */
  getSnapshot(shipId: string): ReturnType<Actor<typeof shipMachine>["getSnapshot"]> | undefined {
    const actor = this.actors.get(shipId);
    if (!actor) return undefined;
    return actor.getSnapshot();
  }

  /**
   * Get the persisted snapshot for a Ship's Actor (ADR-0017).
   * Returns the serializable snapshot suitable for DB storage and later restoration
   * via `createActor(shipMachine, { snapshot })`.
   */
  getPersistedSnapshot(shipId: string): unknown | undefined {
    const actor = this.actors.get(shipId);
    if (!actor) return undefined;
    return actor.getPersistedSnapshot();
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
   * Assert that the XState actor phase matches the expected DB phase.
   * Logs a warning on mismatch (non-blocking diagnostic for #689).
   * Returns true if consistent, false if mismatched or actor not found.
   */
  assertPhaseConsistency(shipId: string, dbPhase: Phase): boolean {
    const actorPhase = this.getPhase(shipId);
    if (actorPhase === undefined) {
      console.warn(
        `[ship-actor-manager] Phase consistency check: no actor for Ship ${shipId.slice(0, 8)}...`,
      );
      return false;
    }
    if (actorPhase !== dbPhase) {
      console.error(
        `[ship-actor-manager] Phase consistency MISMATCH for Ship ${shipId.slice(0, 8)}...: ` +
        `XState=${actorPhase}, DB=${dbPhase}`,
      );
      return false;
    }
    return true;
  }

  /**
   * @deprecated Downgraded to drift detection logger (ADR-0021).
   * PhaseTransactionService now ensures DB-first ordering, making routine reconciliation unnecessary.
   * Still used for: (1) Engine restart/restore flows, (2) DB persist failure rollback in PhaseTransactionService.
   */
  reconcilePhase(shipId: string, dbPhase: Phase, persistedSnapshot?: unknown): boolean {
    const actorPhase = this.getPhase(shipId);

    if (actorPhase === undefined) {
      console.warn(
        `[ship-actor-manager] reconcilePhase: no actor for Ship ${shipId.slice(0, 8)}... — skipping`,
      );
      return false;
    }

    if (actorPhase === dbPhase) return false;

    // Terminal phases: stop actor
    if (dbPhase === "done") {
      console.warn(
        `[ship-actor-manager] reconcilePhase: DB phase is "done" for Ship ${shipId.slice(0, 8)}... — stopping actor`,
      );
      this.stopActor(shipId);
      return true;
    }

    // Log drift for observability but still repair (needed for Engine restart)
    console.warn(
      `[ship-actor-manager] reconcilePhase: drift detected for Ship ${shipId.slice(0, 8)}... ` +
      `XState=${actorPhase}, DB=${dbPhase} — repairing`,
    );

    const oldContext = this.getContext(shipId);
    this.stopActor(shipId);

    const input: ShipMachineInput = {
      shipId,
      fleetId: oldContext?.fleetId ?? "",
      repo: oldContext?.repo ?? "",
      issueNumber: oldContext?.issueNumber ?? 0,
      worktreePath: oldContext?.worktreePath ?? "",
      branchName: oldContext?.branchName ?? "",
      sessionId: oldContext?.sessionId ?? null,
      prUrl: oldContext?.prUrl ?? null,
      qaRequired: oldContext?.qaRequired ?? true,
      phaseBeforeStopped: oldContext?.phaseBeforeStopped ?? null,
    };

    if (persistedSnapshot) {
      try {
        const actor = createActor(shipMachine, {
          input,
          snapshot: persistedSnapshot as PersistedSnapshot,
        });
        this.setupSubscription(shipId, actor);
        actor.start();
        this.actors.set(shipId, actor);

        const restoredPhase = this.getPhase(shipId);
        if (restoredPhase === dbPhase) {
          console.log(
            `[ship-actor-manager] reconcilePhase: Ship ${shipId.slice(0, 8)}... repaired from snapshot to ${dbPhase}`,
          );
          return true;
        }

        console.warn(
          `[ship-actor-manager] reconcilePhase: snapshot mismatch for Ship ${shipId.slice(0, 8)}...: ` +
          `snapshot=${restoredPhase}, DB=${dbPhase} — falling back to replay`,
        );
        this.stopActor(shipId);
      } catch (err) {
        console.warn(
          `[ship-actor-manager] reconcilePhase: snapshot restoration failed for Ship ${shipId.slice(0, 8)}... — falling back to replay:`,
          err,
        );
        this.stopActor(shipId);
      }
    }

    const actor = createActor(shipMachine, { input });
    this.setupSubscription(shipId, actor);
    actor.start();
    this.actors.set(shipId, actor);

    this.replayToPhase(shipId, actor, dbPhase, oldContext?.phaseBeforeStopped ?? null);

    const newPhase = this.getPhase(shipId);
    if (newPhase !== dbPhase) {
      console.error(
        `[ship-actor-manager] reconcilePhase: replay failed for Ship ${shipId.slice(0, 8)}... ` +
        `expected=${dbPhase}, got=${newPhase}`,
      );
      return false;
    }

    console.log(
      `[ship-actor-manager] reconcilePhase: Ship ${shipId.slice(0, 8)}... repaired to ${dbPhase}`,
    );
    return true;
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
    // For "paused"/"abandoned" ships: replay to phaseBeforeStopped, then send PAUSE (+ ABANDON)
    const isPaused = targetPhase === "paused";
    const isAbandoned = targetPhase === "abandoned";
    const replayTarget = (isPaused || isAbandoned) && phaseBeforeStopped
      ? phaseBeforeStopped
      : targetPhase;

    const events = PHASE_REPLAY_EVENTS[replayTarget];
    if (!events || events.length === 0) {
      if (isPaused || isAbandoned) {
        // phaseBeforeStopped is "plan" or unknown — just send PAUSE from initial state
        this.replayingShips.add(shipId);
        actor.send({ type: "PAUSE" });
        if (isAbandoned) {
          actor.send({ type: "ABANDON" });
        }
        this.replayingShips.delete(shipId);
      }
      return;
    }

    this.replayingShips.add(shipId);
    for (const event of events) {
      actor.send(event);
    }
    if (isPaused || isAbandoned) {
      actor.send({ type: "PAUSE" });
      if (isAbandoned) {
        actor.send({ type: "ABANDON" });
      }
    }
    this.replayingShips.delete(shipId);
  }

  private setupSubscription(
    shipId: string,
    actor: Actor<typeof shipMachine>,
  ): void {
    let previousPhase: string | null = null;

    actor.subscribe((snapshot) => {
      const currentPhase = snapshot.value as string;

      if (currentPhase === previousPhase) return;

      const isInitial = previousPhase === null;
      previousPhase = currentPhase;

      if (isInitial) return;

      if (this.replayingShips.has(shipId)) return;

      const phase = stateValueToPhase(currentPhase);

      this.sideEffects?.onPhaseChange(shipId, phase);
    });
  }
}
