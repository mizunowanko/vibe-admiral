import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipActorManager, type ShipActorSideEffects } from "../ship-actor-manager.js";
import type { ShipMachineInput } from "../ship-machine.js";
import type { ShipProcess } from "../types.js";

const DEFAULT_INPUT: ShipMachineInput = {
  shipId: "ship-1",
  fleetId: "fleet-1",
  repo: "owner/repo",
  issueNumber: 42,
  worktreePath: "/tmp/worktree",
  branchName: "feature/42-test",
};

function createMockShipProcess(overrides?: Partial<ShipProcess>): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    phase: "coding",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/tmp/worktree",
    sessionId: "sess-abc",
    prUrl: null,
    prReviewStatus: null,
    gateCheck: null,
    qaRequired: true,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastOutputAt: null,
    ...overrides,
  };
}

function createMockSideEffects(): ShipActorSideEffects {
  return {
    onPhaseChange: vi.fn(),
    onRecordTransition: vi.fn(),
    onLaunchEscort: vi.fn(),
  };
}

describe("ShipActorManager", () => {
  let manager: ShipActorManager;
  let sideEffects: ShipActorSideEffects;

  beforeEach(() => {
    manager = new ShipActorManager();
    sideEffects = createMockSideEffects();
    manager.setSideEffects(sideEffects);
  });

  describe("createActor", () => {
    it("creates an actor and tracks it", () => {
      manager.createActor(DEFAULT_INPUT);
      expect(manager.hasActor("ship-1")).toBe(true);
      expect(manager.getPhase("ship-1")).toBe("plan");
      manager.stopAll();
    });

    it("stops existing actor on re-create (re-sortie)", () => {
      manager.createActor(DEFAULT_INPUT);
      expect(manager.getPhase("ship-1")).toBe("plan");
      // Send event to advance state
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(manager.getPhase("ship-1")).toBe("plan-gate");
      // Re-create should reset to plan
      manager.createActor(DEFAULT_INPUT);
      expect(manager.getPhase("ship-1")).toBe("plan");
      manager.stopAll();
    });
  });

  describe("restoreActor", () => {
    it("restores actor and replays to DB phase", () => {
      const ship = createMockShipProcess({ phase: "coding" });
      manager.restoreActor(ship);
      expect(manager.hasActor("ship-1")).toBe(true);
      // XState should be replayed to "coding", not stuck at "plan"
      expect(manager.getPhase("ship-1")).toBe("coding");
      manager.stopAll();
    });

    it("replays to plan-gate phase", () => {
      const ship = createMockShipProcess({ phase: "plan-gate" });
      manager.restoreActor(ship);
      expect(manager.getPhase("ship-1")).toBe("plan-gate");
      manager.stopAll();
    });

    it("replays to qa phase", () => {
      const ship = createMockShipProcess({ phase: "qa" });
      manager.restoreActor(ship);
      expect(manager.getPhase("ship-1")).toBe("qa");
      manager.stopAll();
    });

    it("replays to merging phase", () => {
      const ship = createMockShipProcess({ phase: "merging" });
      manager.restoreActor(ship);
      expect(manager.getPhase("ship-1")).toBe("merging");
      manager.stopAll();
    });

    it("restores actor for stopped phase with phaseBeforeStopped", () => {
      const ship = createMockShipProcess({ phase: "stopped" });
      manager.restoreActor(ship, "coding");
      expect(manager.getPhase("ship-1")).toBe("stopped");
      // Verify the actor is in stopped state and can resume to coding
      manager.send("ship-1", { type: "RESUME" });
      expect(manager.getPhase("ship-1")).toBe("coding");
      manager.stopAll();
    });

    it("restores stopped actor when phaseBeforeStopped is plan", () => {
      const ship = createMockShipProcess({ phase: "stopped" });
      manager.restoreActor(ship, "plan");
      expect(manager.getPhase("ship-1")).toBe("stopped");
      manager.stopAll();
    });

    it("returns null for done phase", () => {
      const ship = createMockShipProcess({ phase: "done" });
      const result = manager.restoreActor(ship);
      expect(result).toBeNull();
      expect(manager.hasActor("ship-1")).toBe(false);
    });

    it("does not fire onPhaseChange during replay", () => {
      const ship = createMockShipProcess({ phase: "coding" });
      manager.restoreActor(ship);
      // Side effects should be suppressed during replay
      expect(sideEffects.onPhaseChange).not.toHaveBeenCalled();
      manager.stopAll();
    });

    it("transitions correctly after restore (GATE_ENTER from coding → coding-gate)", () => {
      const ship = createMockShipProcess({ phase: "coding" });
      manager.restoreActor(ship);
      expect(manager.getPhase("ship-1")).toBe("coding");
      // This is the key fix: GATE_ENTER should now go to coding-gate, not plan-gate
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(manager.getPhase("ship-1")).toBe("coding-gate");
      manager.stopAll();
    });

    it("fires onPhaseChange for transitions after restore", () => {
      const ship = createMockShipProcess({ phase: "coding" });
      manager.restoreActor(ship);
      (sideEffects.onPhaseChange as ReturnType<typeof vi.fn>).mockClear();
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(sideEffects.onPhaseChange).toHaveBeenCalledWith("ship-1", "coding-gate");
      manager.stopAll();
    });
  });

  describe("send", () => {
    it("sends event to existing actor", () => {
      manager.createActor(DEFAULT_INPUT);
      const result = manager.send("ship-1", { type: "GATE_ENTER" });
      expect(result).toBe(true);
      expect(manager.getPhase("ship-1")).toBe("plan-gate");
      manager.stopAll();
    });

    it("returns false for non-existent actor", () => {
      const result = manager.send("nonexistent", { type: "GATE_ENTER" });
      expect(result).toBe(false);
    });
  });

  describe("getPhase", () => {
    it("returns undefined for non-existent actor", () => {
      expect(manager.getPhase("nonexistent")).toBeUndefined();
    });

    it("returns current phase for active actor", () => {
      manager.createActor(DEFAULT_INPUT);
      expect(manager.getPhase("ship-1")).toBe("plan");
      manager.stopAll();
    });
  });

  describe("getContext", () => {
    it("returns full context for active actor", () => {
      manager.createActor(DEFAULT_INPUT);
      const ctx = manager.getContext("ship-1");
      expect(ctx).toBeDefined();
      expect(ctx?.shipId).toBe("ship-1");
      expect(ctx?.issueNumber).toBe(42);
      manager.stopAll();
    });

    it("returns undefined for non-existent actor", () => {
      expect(manager.getContext("nonexistent")).toBeUndefined();
    });
  });

  describe("stopActor", () => {
    it("stops and removes actor", () => {
      manager.createActor(DEFAULT_INPUT);
      expect(manager.hasActor("ship-1")).toBe(true);
      manager.stopActor("ship-1");
      expect(manager.hasActor("ship-1")).toBe(false);
      expect(manager.getPhase("ship-1")).toBeUndefined();
    });

    it("clears replayed actor on stop", () => {
      const ship = createMockShipProcess({ phase: "coding" });
      manager.restoreActor(ship);
      expect(manager.getPhase("ship-1")).toBe("coding");
      manager.stopActor("ship-1");
      expect(manager.getPhase("ship-1")).toBeUndefined();
    });
  });

  describe("stopAll", () => {
    it("stops all actors", () => {
      manager.createActor({ ...DEFAULT_INPUT, shipId: "ship-1" });
      manager.createActor({ ...DEFAULT_INPUT, shipId: "ship-2" });
      expect(manager.getActiveShipIds()).toHaveLength(2);
      manager.stopAll();
      expect(manager.getActiveShipIds()).toHaveLength(0);
    });
  });

  describe("getActiveShipIds", () => {
    it("returns empty array when no actors", () => {
      expect(manager.getActiveShipIds()).toEqual([]);
    });

    it("returns all active ship IDs", () => {
      manager.createActor({ ...DEFAULT_INPUT, shipId: "ship-1" });
      manager.createActor({ ...DEFAULT_INPUT, shipId: "ship-2" });
      const ids = manager.getActiveShipIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("ship-1");
      expect(ids).toContain("ship-2");
      manager.stopAll();
    });
  });

  describe("requestTransition", () => {
    it("returns success with phase change on valid transition", () => {
      manager.createActor(DEFAULT_INPUT);
      const result = manager.requestTransition("ship-1", { type: "GATE_ENTER" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.fromPhase).toBe("plan");
        expect(result.toPhase).toBe("plan-gate");
      }
      manager.stopAll();
    });

    it("returns failure when XState rejects the event", () => {
      manager.createActor(DEFAULT_INPUT);
      // plan state does not accept GATE_APPROVED — only GATE_ENTER
      const result = manager.requestTransition("ship-1", { type: "GATE_APPROVED" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.currentPhase).toBe("plan");
      }
      // Phase should not have changed
      expect(manager.getPhase("ship-1")).toBe("plan");
      manager.stopAll();
    });

    it("returns failure with undefined currentPhase when no actor exists", () => {
      const result = manager.requestTransition("nonexistent", { type: "GATE_ENTER" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.currentPhase).toBeUndefined();
      }
    });

    it("supports gate rejection (gate → previous work phase)", () => {
      manager.createActor(DEFAULT_INPUT);
      // Advance to plan-gate
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(manager.getPhase("ship-1")).toBe("plan-gate");

      // Reject the gate
      const result = manager.requestTransition("ship-1", { type: "GATE_REJECTED", feedback: "needs work" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.fromPhase).toBe("plan-gate");
        expect(result.toPhase).toBe("plan");
      }
      manager.stopAll();
    });

    it("supports ESCORT_DIED event (gate → previous work phase)", () => {
      manager.createActor(DEFAULT_INPUT);
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(manager.getPhase("ship-1")).toBe("plan-gate");

      const result = manager.requestTransition("ship-1", {
        type: "ESCORT_DIED",
        exitCode: 1,
        feedback: "Escort process crashed",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.fromPhase).toBe("plan-gate");
        expect(result.toPhase).toBe("plan");
      }
      manager.stopAll();
    });

    it("supports NOTHING_TO_DO event (any work phase → done)", () => {
      manager.createActor(DEFAULT_INPUT);
      const result = manager.requestTransition("ship-1", { type: "NOTHING_TO_DO", reason: "issue resolved" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.fromPhase).toBe("plan");
        expect(result.toPhase).toBe("done");
      }
      manager.stopAll();
    });

    it("prevents skipping phases (e.g. plan → merging)", () => {
      manager.createActor(DEFAULT_INPUT);
      // COMPLETE event from plan should not transition (merging → done is valid, but plan → done via COMPLETE is not)
      const result = manager.requestTransition("ship-1", { type: "COMPLETE" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.currentPhase).toBe("plan");
      }
      manager.stopAll();
    });
  });

  describe("assertPhaseConsistency", () => {
    it("returns true when XState phase matches DB phase", () => {
      manager.createActor(DEFAULT_INPUT);
      expect(manager.assertPhaseConsistency("ship-1", "plan")).toBe(true);
      manager.stopAll();
    });

    it("returns false and logs error on phase mismatch", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      manager.createActor(DEFAULT_INPUT);
      // XState is in "plan", but DB says "coding" — mismatch
      expect(manager.assertPhaseConsistency("ship-1", "coding")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Phase consistency MISMATCH"),
      );
      errorSpy.mockRestore();
      manager.stopAll();
    });

    it("returns false when actor does not exist", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(manager.assertPhaseConsistency("nonexistent", "plan")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no actor for Ship"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("side effects", () => {
    it("fires onPhaseChange when actor transitions", () => {
      manager.createActor(DEFAULT_INPUT);
      manager.send("ship-1", { type: "GATE_ENTER" });
      expect(sideEffects.onPhaseChange).toHaveBeenCalledWith("ship-1", "plan-gate");
      manager.stopAll();
    });

    it("does not fire onPhaseChange for context-only updates", () => {
      manager.createActor(DEFAULT_INPUT);
      (sideEffects.onPhaseChange as ReturnType<typeof vi.fn>).mockClear();
      manager.send("ship-1", { type: "PROCESS_OUTPUT", timestamp: 123 });
      // PROCESS_OUTPUT doesn't change phase, only context
      expect(sideEffects.onPhaseChange).not.toHaveBeenCalled();
      manager.stopAll();
    });
  });
});
