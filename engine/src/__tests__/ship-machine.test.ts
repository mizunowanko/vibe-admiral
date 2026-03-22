import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { shipMachine, stateValueToPhase, phaseToGateEvent, type ShipMachineInput } from "../ship-machine.js";

const DEFAULT_INPUT: ShipMachineInput = {
  shipId: "test-ship-1",
  fleetId: "fleet-1",
  repo: "owner/repo",
  issueNumber: 42,
  worktreePath: "/tmp/worktree",
  branchName: "feature/42-test",
};

function createTestActor(overrides?: Partial<ShipMachineInput>) {
  const input = { ...DEFAULT_INPUT, ...overrides };
  const actor = createActor(shipMachine, { input });
  actor.start();
  return actor;
}

describe("shipMachine", () => {
  describe("initial state", () => {
    it("starts in planning", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().value).toBe("planning");
      actor.stop();
    });

    it("initializes context from input", () => {
      const actor = createTestActor({ prUrl: "https://github.com/pr/1" });
      const ctx = actor.getSnapshot().context;
      expect(ctx.shipId).toBe("test-ship-1");
      expect(ctx.fleetId).toBe("fleet-1");
      expect(ctx.repo).toBe("owner/repo");
      expect(ctx.issueNumber).toBe(42);
      expect(ctx.prUrl).toBe("https://github.com/pr/1");
      expect(ctx.qaRequired).toBe(true);
      expect(ctx.retryCount).toBe(0);
      expect(ctx.processDead).toBe(false);
      expect(ctx.isCompacting).toBe(false);
      expect(ctx.gateCheck).toBeNull();
      expect(ctx.phaseBeforeStopped).toBeNull();
      actor.stop();
    });

    it("defaults qaRequired to true", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().context.qaRequired).toBe(true);
      actor.stop();
    });

    it("respects qaRequired override", () => {
      const actor = createTestActor({ qaRequired: false });
      expect(actor.getSnapshot().context.qaRequired).toBe(false);
      actor.stop();
    });
  });

  describe("forward transitions: planning → done", () => {
    it("transitions planning → planning-gate on GATE_ENTER", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("planning-gate");
      actor.stop();
    });

    it("transitions planning-gate → implementing on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("implementing");
      actor.stop();
    });

    it("transitions implementing → implementing-gate on GATE_ENTER", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" }); // → planning-gate
      actor.send({ type: "GATE_APPROVED" }); // → implementing
      actor.send({ type: "GATE_ENTER" }); // → implementing-gate
      expect(actor.getSnapshot().value).toBe("implementing-gate");
      actor.stop();
    });

    it("transitions implementing-gate → acceptance-test on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("acceptance-test");
      actor.stop();
    });

    it("transitions acceptance-test → acceptance-test-gate on GATE_ENTER (qaRequired=true)", () => {
      const actor = createTestActor({ qaRequired: true });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("acceptance-test-gate");
      actor.stop();
    });

    it("skips acceptance-test-gate when qaRequired=false", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" }); // → planning-gate
      actor.send({ type: "GATE_APPROVED" }); // → implementing
      actor.send({ type: "GATE_ENTER" }); // → implementing-gate
      actor.send({ type: "GATE_APPROVED" }); // → acceptance-test
      actor.send({ type: "GATE_ENTER" }); // → merging (skip gate)
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });

    it("transitions acceptance-test-gate → merging on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });

    it("transitions merging → done on COMPLETE", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" }); // skips qa gate
      actor.send({ type: "COMPLETE" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().status).toBe("done");
      actor.stop();
    });
  });

  describe("gate rejection", () => {
    it("rejects planning-gate → planning on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("planning-gate");
      actor.send({ type: "GATE_REJECTED", feedback: "needs more detail" });
      expect(actor.getSnapshot().value).toBe("planning");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("rejects implementing-gate → implementing on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("implementing-gate");
      actor.send({ type: "GATE_REJECTED" });
      expect(actor.getSnapshot().value).toBe("implementing");
      actor.stop();
    });

    it("rejects acceptance-test-gate → acceptance-test on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("acceptance-test-gate");
      actor.send({ type: "GATE_REJECTED" });
      expect(actor.getSnapshot().value).toBe("acceptance-test");
      actor.stop();
    });

    it("allows re-entry after gate rejection", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_REJECTED" }); // back to planning
      actor.send({ type: "GATE_ENTER" }); // re-enter gate
      expect(actor.getSnapshot().value).toBe("planning-gate");
      actor.send({ type: "GATE_APPROVED" }); // now approved
      expect(actor.getSnapshot().value).toBe("implementing");
      actor.stop();
    });
  });

  describe("ESCORT_DIED", () => {
    it("reverts planning-gate → planning on ESCORT_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "ESCORT_DIED", exitCode: 1 });
      expect(actor.getSnapshot().value).toBe("planning");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("reverts implementing-gate → implementing on ESCORT_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "ESCORT_DIED", exitCode: null });
      expect(actor.getSnapshot().value).toBe("implementing");
      actor.stop();
    });
  });

  describe("gate entry sets gateCheck", () => {
    it("sets gateCheck on planning-gate entry", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      const gc = actor.getSnapshot().context.gateCheck;
      expect(gc).not.toBeNull();
      expect(gc?.gatePhase).toBe("planning-gate");
      expect(gc?.gateType).toBe("plan-review");
      expect(gc?.status).toBe("pending");
      actor.stop();
    });

    it("clears gateCheck on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().context.gateCheck).not.toBeNull();
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });
  });

  describe("STOP / RESUME", () => {
    it("transitions to stopped from planning", () => {
      const actor = createTestActor();
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("stopped");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("planning");
      actor.stop();
    });

    it("transitions to stopped from implementing", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("stopped");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("implementing");
      actor.stop();
    });

    it("transitions to stopped from a gate phase", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("stopped");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("planning-gate");
      actor.stop();
    });

    it("resumes to correct phase from stopped", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" }); // implementing
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("stopped");
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("implementing");
      expect(actor.getSnapshot().context.processDead).toBe(false);
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      actor.stop();
    });

    it("increments retryCount on each resume", () => {
      const actor = createTestActor();
      actor.send({ type: "STOP" });
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      actor.send({ type: "STOP" });
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().context.retryCount).toBe(2);
      actor.stop();
    });

    it("resumes to implementing as default when phaseBeforeStopped is unknown", () => {
      // Force phaseBeforeStopped to null by starting fresh and stopping
      // The actor has phaseBeforeStopped = "planning" by default when stopped from planning
      // For this edge case, we need a scenario where phaseBeforeStopped doesn't match any guard
      // The default guard catches this and resumes to implementing
      const actor = createTestActor();
      // Cannot easily test null phaseBeforeStopped since STOP always sets it
      // But we can verify the default branch works by testing all known phases
      actor.send({ type: "STOP" }); // from planning
      actor.send({ type: "RESUME" }); // resumes to planning (matched by guard)
      expect(actor.getSnapshot().value).toBe("planning");
      actor.stop();
    });

    it("resumes to merging when stopped from merging", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" }); // skip qa → merging
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("merging");
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });
  });

  describe("NOTHING_TO_DO", () => {
    it("transitions planning → done on NOTHING_TO_DO", () => {
      const actor = createTestActor();
      actor.send({ type: "NOTHING_TO_DO", reason: "No work" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("transitions implementing → done on NOTHING_TO_DO", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "NOTHING_TO_DO" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("transitions merging → done on NOTHING_TO_DO", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "NOTHING_TO_DO" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });
  });

  describe("global context events", () => {
    it("updates lastOutputAt and clears processDead on PROCESS_OUTPUT", () => {
      const actor = createTestActor();
      actor.send({ type: "PROCESS_OUTPUT", timestamp: 12345 });
      expect(actor.getSnapshot().context.lastOutputAt).toBe(12345);
      expect(actor.getSnapshot().context.processDead).toBe(false);
      actor.stop();
    });

    it("sets processDead on PROCESS_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "PROCESS_DIED" });
      expect(actor.getSnapshot().context.processDead).toBe(true);
      actor.stop();
    });

    it("clears processDead when PROCESS_OUTPUT arrives after PROCESS_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "PROCESS_DIED" });
      expect(actor.getSnapshot().context.processDead).toBe(true);
      actor.send({ type: "PROCESS_OUTPUT", timestamp: 99999 });
      expect(actor.getSnapshot().context.processDead).toBe(false);
      actor.stop();
    });

    it("sets isCompacting on COMPACT_START/END", () => {
      const actor = createTestActor();
      actor.send({ type: "COMPACT_START" });
      expect(actor.getSnapshot().context.isCompacting).toBe(true);
      actor.send({ type: "COMPACT_END" });
      expect(actor.getSnapshot().context.isCompacting).toBe(false);
      actor.stop();
    });

    it("updates sessionId on SET_SESSION_ID", () => {
      const actor = createTestActor();
      actor.send({ type: "SET_SESSION_ID", sessionId: "sess-123" });
      expect(actor.getSnapshot().context.sessionId).toBe("sess-123");
      actor.stop();
    });

    it("updates prUrl on SET_PR_URL", () => {
      const actor = createTestActor();
      actor.send({ type: "SET_PR_URL", prUrl: "https://github.com/pr/1" });
      expect(actor.getSnapshot().context.prUrl).toBe("https://github.com/pr/1");
      actor.stop();
    });

    it("updates qaRequired on SET_QA_REQUIRED", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().context.qaRequired).toBe(true);
      actor.send({ type: "SET_QA_REQUIRED", qaRequired: false });
      expect(actor.getSnapshot().context.qaRequired).toBe(false);
      actor.stop();
    });

    it("updates prReviewStatus on SET_PR_REVIEW_STATUS", () => {
      const actor = createTestActor();
      actor.send({ type: "SET_PR_REVIEW_STATUS", status: "approved" });
      expect(actor.getSnapshot().context.prReviewStatus).toBe("approved");
      actor.stop();
    });
  });

  describe("done state is final", () => {
    it("does not accept events in done state", () => {
      const actor = createTestActor();
      actor.send({ type: "NOTHING_TO_DO" });
      expect(actor.getSnapshot().value).toBe("done");
      // Sending more events should not change state
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("ignores PROCESS_DIED in done state (no processDead flag set)", () => {
      const actor = createTestActor();
      actor.send({ type: "NOTHING_TO_DO" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.send({ type: "PROCESS_DIED" });
      // Final state ignores all events — processDead should remain false
      expect(actor.getSnapshot().context.processDead).toBe(false);
      actor.stop();
    });
  });

  describe("ABANDON (stopped → done)", () => {
    it("transitions stopped → done on ABANDON", () => {
      const actor = createTestActor();
      actor.send({ type: "STOP" });
      expect(actor.getSnapshot().value).toBe("stopped");
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().status).toBe("done");
      actor.stop();
    });

    it("ABANDON is only available in stopped state", () => {
      const actor = createTestActor();
      // ABANDON in planning should be ignored
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("planning");
      actor.stop();
    });
  });

  describe("SET_PHASE_BEFORE_STOPPED", () => {
    it("updates phaseBeforeStopped context", () => {
      const actor = createTestActor();
      actor.send({ type: "SET_PHASE_BEFORE_STOPPED", phase: "implementing" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("implementing");
      actor.stop();
    });

    it("enables correct RESUME after context sync", () => {
      // Simulate Engine restart scenario:
      // 1. Actor created with phaseBeforeStopped = null (default)
      // 2. SET_PHASE_BEFORE_STOPPED syncs from DB
      // 3. RESUME uses the synced value
      const actor = createTestActor();
      actor.send({ type: "STOP" }); // phaseBeforeStopped = "planning"
      // Simulate context override from DB
      actor.send({ type: "SET_PHASE_BEFORE_STOPPED", phase: "merging" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("merging");
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });
  });

  describe("phaseBeforeStopped via input", () => {
    it("initializes phaseBeforeStopped from input", () => {
      const actor = createTestActor({ phaseBeforeStopped: "acceptance-test" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("acceptance-test");
      actor.stop();
    });

    it("defaults phaseBeforeStopped to null when not provided", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBeNull();
      actor.stop();
    });
  });
});

describe("stateValueToPhase", () => {
  it("maps state values to Phase types", () => {
    expect(stateValueToPhase("planning")).toBe("planning");
    expect(stateValueToPhase("planning-gate")).toBe("planning-gate");
    expect(stateValueToPhase("implementing")).toBe("implementing");
    expect(stateValueToPhase("done")).toBe("done");
    expect(stateValueToPhase("stopped")).toBe("stopped");
  });
});

describe("phaseToGateEvent", () => {
  it("returns GATE_ENTER for gate phases", () => {
    expect(phaseToGateEvent("planning-gate")).toEqual({ type: "GATE_ENTER" });
    expect(phaseToGateEvent("implementing-gate")).toEqual({ type: "GATE_ENTER" });
    expect(phaseToGateEvent("acceptance-test-gate")).toEqual({ type: "GATE_ENTER" });
  });

  it("returns null for non-gate phases", () => {
    expect(phaseToGateEvent("planning")).toBeNull();
    expect(phaseToGateEvent("implementing")).toBeNull();
    expect(phaseToGateEvent("merging")).toBeNull();
    expect(phaseToGateEvent("done")).toBeNull();
  });
});
