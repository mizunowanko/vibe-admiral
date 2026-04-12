import { describe, it, expect, vi } from "vitest";
import { PhaseTransactionService } from "../phase-transaction-service.js";
import type { ShipActorManager } from "../ship-actor-manager.js";
import type { ShipManager } from "../ship-manager.js";
import type { FleetDatabase } from "../db.js";

function createMocks() {
  const mockActorManager = {
    getPhase: vi.fn().mockReturnValue("plan"),
    getSnapshot: vi.fn().mockReturnValue({ value: "plan", can: vi.fn().mockReturnValue(true) }),
    requestTransition: vi.fn().mockReturnValue({ success: true, fromPhase: "plan", toPhase: "plan-gate" }),
    getPersistedSnapshot: vi.fn().mockReturnValue({ value: "plan-gate", context: {} }),
    reconcilePhase: vi.fn().mockReturnValue(true),
  } as unknown as ShipActorManager;

  const mockShipManager = {
    syncPhaseFromDb: vi.fn(),
    clearGateCheck: vi.fn(),
  } as unknown as ShipManager;

  const mockDb = {
    getShipById: vi.fn().mockReturnValue({ id: "ship-1", phase: "plan" }),
    persistPhaseTransition: vi.fn().mockReturnValue(true),
    updateActorSnapshot: vi.fn(),
    clearGateIntent: vi.fn(),
  } as unknown as FleetDatabase;

  const service = new PhaseTransactionService(
    mockActorManager,
    mockShipManager,
    () => mockDb,
  );

  return { service, mockActorManager, mockShipManager, mockDb };
}

describe("PhaseTransactionService", () => {
  describe("commit()", () => {
    it("executes full 6-step sequence on success", () => {
      const { service, mockActorManager, mockShipManager, mockDb } = createMocks();

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
        metadata: { commentUrl: "https://example.com" },
      });

      expect(result).toEqual({ success: true, fromPhase: "plan", toPhase: "plan-gate" });

      // Step 1: Consistency check (getPhase + getShipById)
      expect(mockActorManager.getPhase).toHaveBeenCalledWith("ship-1");
      expect(mockDb.getShipById).toHaveBeenCalledWith("ship-1");

      // Step 2: can() check
      const snapshot = (mockActorManager.getSnapshot as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(snapshot?.can).toHaveBeenCalledWith({ type: "GATE_ENTER" });

      // Step 3: XState transition
      expect(mockActorManager.requestTransition).toHaveBeenCalledWith("ship-1", { type: "GATE_ENTER" });

      // Step 4: DB persist
      expect(mockDb.persistPhaseTransition).toHaveBeenCalledWith(
        "ship-1", "plan", "plan-gate", "ship",
        { commentUrl: "https://example.com" },
        expect.anything(),
      );

      // Step 5: Sync + clear
      expect(mockShipManager.syncPhaseFromDb).toHaveBeenCalledWith("ship-1");
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
      expect(mockDb.clearGateIntent).toHaveBeenCalledWith("ship-1");
    });

    it("rejects when DB ↔ XState phase mismatch (CONSISTENCY_MISMATCH)", () => {
      const { service, mockActorManager } = createMocks();
      (mockActorManager.getPhase as ReturnType<typeof vi.fn>).mockReturnValue("coding");

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Phase mismatch"),
        code: "CONSISTENCY_MISMATCH",
      });
    });

    it("rejects when no actor exists (NO_ACTOR)", () => {
      const { service, mockActorManager } = createMocks();
      (mockActorManager.getPhase as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("No actor"),
        code: "NO_ACTOR",
      });
    });

    it("rejects when ship not found in DB (NO_ACTOR)", () => {
      const { service, mockDb } = createMocks();
      (mockDb.getShipById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("not found"),
        code: "NO_ACTOR",
      });
    });

    it("rejects when XState can() returns false (TRANSITION_REJECTED)", () => {
      const { service, mockActorManager } = createMocks();
      const snapshot = { value: "plan", can: vi.fn().mockReturnValue(false) };
      (mockActorManager.getSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(snapshot);

      const result = service.commit("ship-1", {
        event: { type: "COMPLETE" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Transition rejected"),
        code: "TRANSITION_REJECTED",
      });
      expect(mockActorManager.requestTransition).not.toHaveBeenCalled();
    });

    it("rolls back XState via reconcilePhase when DB persist fails", () => {
      const { service, mockActorManager, mockDb, mockShipManager } = createMocks();
      (mockDb.persistPhaseTransition as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB write failed");
      });

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: "DB persist failed",
        code: "DB_PERSIST_FAILED",
      });

      // XState transition happened (step 3)
      expect(mockActorManager.requestTransition).toHaveBeenCalled();
      // Rollback via reconcilePhase
      expect(mockActorManager.reconcilePhase).toHaveBeenCalledWith("ship-1", "plan");
      // syncPhaseFromDb should NOT be called on failure
      expect(mockShipManager.syncPhaseFromDb).not.toHaveBeenCalled();
    });

    it("returns DB_PERSIST_FAILED when no database", () => {
      const { mockActorManager, mockShipManager } = createMocks();
      const service = new PhaseTransactionService(
        mockActorManager,
        mockShipManager,
        () => null,
      );

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: "Database not initialized",
        code: "DB_PERSIST_FAILED",
      });
    });

    it("handles requestTransition failure after can() succeeds", () => {
      const { service, mockActorManager } = createMocks();
      (mockActorManager.requestTransition as ReturnType<typeof vi.fn>).mockReturnValue({
        success: false,
        currentPhase: "plan",
      });

      const result = service.commit("ship-1", {
        event: { type: "GATE_ENTER" },
        triggeredBy: "ship",
      });

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Transition rejected"),
        code: "TRANSITION_REJECTED",
      });
    });
  });
});
