/**
 * PhaseTransactionService — Single atomic boundary for all phase transitions.
 *
 * Consolidates the phase transition sequence (ADR-0021):
 *   1. assertPhaseConsistency (DB ↔ XState)
 *   2. can() check (validate event is accepted without side effects)
 *   3. requestTransition (XState transition — subscribers only log)
 *   4. DB persist (phase_transitions + actor_snapshot)
 *   5. syncPhaseFromDb (triggers notifyPhaseWaiters — only after DB success)
 *   6. clearGateCheck / clearGateIntent
 *
 * If DB persist fails after XState transition, reconcilePhase repairs the actor.
 *
 * @see adr/0021-phase-transaction-service.md
 */
import type { ShipMachineEvent } from "./ship-machine.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { Phase } from "./types.js";

export interface PhaseCommitOptions {
  event: ShipMachineEvent;
  triggeredBy: "ship" | "escort" | "flagship" | "engine" | "engine-recovery";
  metadata?: Record<string, unknown>;
}

export interface PhaseCommitResult {
  success: true;
  fromPhase: Phase;
  toPhase: Phase;
}

export interface PhaseCommitFailure {
  success: false;
  error: string;
  code: "NO_ACTOR" | "CONSISTENCY_MISMATCH" | "TRANSITION_REJECTED" | "DB_PERSIST_FAILED";
}

export type PhaseCommitOutcome = PhaseCommitResult | PhaseCommitFailure;

export class PhaseTransactionService {
  private actorManager: ShipActorManager;
  private shipManager: ShipManager;
  private getDatabase: () => FleetDatabase | null;

  constructor(
    actorManager: ShipActorManager,
    shipManager: ShipManager,
    getDatabase: () => FleetDatabase | null,
  ) {
    this.actorManager = actorManager;
    this.shipManager = shipManager;
    this.getDatabase = getDatabase;
  }

  /**
   * Execute an atomic phase transition. All steps succeed or the
   * transition is rolled back.
   */
  commit(shipId: string, options: PhaseCommitOptions): PhaseCommitOutcome {
    const { event, triggeredBy, metadata } = options;
    const db = this.getDatabase();
    if (!db) {
      return { success: false, error: "Database not initialized", code: "DB_PERSIST_FAILED" };
    }

    // Step 1: Assert phase consistency (DB ↔ XState)
    const ship = db.getShipById(shipId);
    if (!ship) {
      return { success: false, error: `Ship ${shipId} not found`, code: "NO_ACTOR" };
    }
    const dbPhase = ship.phase as Phase;

    const actorPhase = this.actorManager.getPhase(shipId);
    if (actorPhase === undefined) {
      return { success: false, error: `No actor for Ship ${shipId}`, code: "NO_ACTOR" };
    }

    if (actorPhase !== dbPhase) {
      console.error(
        `[phase-tx] Consistency MISMATCH for Ship ${shipId.slice(0, 8)}...: XState=${actorPhase}, DB=${dbPhase} — rejecting transition`,
      );
      return { success: false, error: `Phase mismatch: XState=${actorPhase}, DB=${dbPhase}`, code: "CONSISTENCY_MISMATCH" };
    }

    // Step 2: Pre-validate with can() — no side effects
    const snapshot = this.actorManager.getSnapshot(shipId);
    if (!snapshot || !snapshot.can(event)) {
      return { success: false, error: `Transition rejected by XState: event=${event.type}, phase=${dbPhase}`, code: "TRANSITION_REJECTED" };
    }

    // Step 3: XState transition (subscribers only log — no external side effects)
    const result = this.actorManager.requestTransition(shipId, event);
    if (!result.success) {
      return { success: false, error: `Transition rejected by XState: event=${event.type}, phase=${dbPhase}`, code: "TRANSITION_REJECTED" };
    }

    // Step 4: DB persist (phase_transitions + actor_snapshot in same SQLite tx)
    const actorSnapshot = this.actorManager.getPersistedSnapshot(shipId);
    try {
      db.persistPhaseTransition(
        shipId,
        result.fromPhase,
        result.toPhase,
        triggeredBy,
        metadata,
        actorSnapshot,
      );
    } catch (err) {
      console.error(
        `[phase-tx] DB persist failed for Ship ${shipId.slice(0, 8)}...: ${result.fromPhase} → ${result.toPhase} — reverting XState`,
        err,
      );
      this.actorManager.reconcilePhase(shipId, result.fromPhase);
      return { success: false, error: "DB persist failed", code: "DB_PERSIST_FAILED" };
    }

    // Step 5: Sync phase + notify waiters
    // syncPhaseFromDb triggers onPhaseChange handler which calls notifyPhaseWaiters.
    // This ensures waiters are only notified AFTER DB persist succeeds (ADR-0021).
    this.shipManager.syncPhaseFromDb(shipId);

    // Step 6: Clear gate state
    this.shipManager.clearGateCheck(shipId);
    this.clearGateIntent(shipId);

    return { success: true, fromPhase: result.fromPhase, toPhase: result.toPhase };
  }

  private clearGateIntent(shipId: string): void {
    const db = this.getDatabase();
    if (!db) return;
    try {
      db.clearGateIntent(shipId);
    } catch {
      // gate_intents table might not exist yet during migration
    }
  }
}
