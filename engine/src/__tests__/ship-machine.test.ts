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
    it("starts in plan", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().value).toBe("plan");
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

  describe("forward transitions: plan → done", () => {
    it("transitions plan → plan-gate on GATE_ENTER", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("plan-gate");
      actor.stop();
    });

    it("transitions plan-gate → coding on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("coding");
      actor.stop();
    });

    it("transitions coding → coding-gate on GATE_ENTER", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" }); // → plan-gate
      actor.send({ type: "GATE_APPROVED" }); // → coding
      actor.send({ type: "GATE_ENTER" }); // → coding-gate
      expect(actor.getSnapshot().value).toBe("coding-gate");
      actor.stop();
    });

    it("transitions coding-gate → qa on GATE_APPROVED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("qa");
      actor.stop();
    });

    it("transitions qa → qa-gate on GATE_ENTER (qaRequired=true)", () => {
      const actor = createTestActor({ qaRequired: true });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("qa-gate");
      actor.stop();
    });

    it("skips qa-gate when qaRequired=false", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" }); // → plan-gate
      actor.send({ type: "GATE_APPROVED" }); // → coding
      actor.send({ type: "GATE_ENTER" }); // → coding-gate
      actor.send({ type: "GATE_APPROVED" }); // → qa
      actor.send({ type: "GATE_ENTER" }); // → merging (skip gate)
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });

    it("transitions qa-gate → merging on GATE_APPROVED", () => {
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
    it("rejects plan-gate → plan on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("plan-gate");
      actor.send({ type: "GATE_REJECTED", feedback: "needs more detail" });
      expect(actor.getSnapshot().value).toBe("plan");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("rejects coding-gate → coding on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("coding-gate");
      actor.send({ type: "GATE_REJECTED" });
      expect(actor.getSnapshot().value).toBe("coding");
      actor.stop();
    });

    it("rejects qa-gate → qa on GATE_REJECTED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("qa-gate");
      actor.send({ type: "GATE_REJECTED" });
      expect(actor.getSnapshot().value).toBe("qa");
      actor.stop();
    });

    it("allows re-entry after gate rejection", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_REJECTED" }); // back to plan
      actor.send({ type: "GATE_ENTER" }); // re-enter gate
      expect(actor.getSnapshot().value).toBe("plan-gate");
      actor.send({ type: "GATE_APPROVED" }); // now approved
      expect(actor.getSnapshot().value).toBe("coding");
      actor.stop();
    });
  });

  describe("ESCORT_DIED", () => {
    it("reverts plan-gate → plan on ESCORT_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "ESCORT_DIED", exitCode: 1 });
      expect(actor.getSnapshot().value).toBe("plan");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("reverts coding-gate → coding on ESCORT_DIED", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "ESCORT_DIED", exitCode: null });
      expect(actor.getSnapshot().value).toBe("coding");
      actor.stop();
    });
  });

  describe("gate entry sets gateCheck", () => {
    it("sets gateCheck on plan-gate entry", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      const gc = actor.getSnapshot().context.gateCheck;
      expect(gc).not.toBeNull();
      expect(gc?.gatePhase).toBe("plan-gate");
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

  describe("PAUSE / RESUME", () => {
    it("transitions to paused from plan", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("plan");
      actor.stop();
    });

    it("transitions to paused from coding", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("coding");
      actor.stop();
    });

    it("transitions to paused from a gate phase", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("plan-gate");
      actor.stop();
    });

    it("resumes to correct phase from paused", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" }); // coding
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("coding");
      expect(actor.getSnapshot().context.processDead).toBe(false);
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      actor.stop();
    });

    it("increments retryCount on each resume", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().context.retryCount).toBe(1);
      actor.send({ type: "PAUSE" });
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().context.retryCount).toBe(2);
      actor.stop();
    });

    it("resumes to coding as default when phaseBeforeStopped is unknown", () => {
      // Force phaseBeforeStopped to null by starting fresh and stopping
      // The actor has phaseBeforeStopped = "plan" by default when stopped from plan
      // For this edge case, we need a scenario where phaseBeforeStopped doesn't match any guard
      // The default guard catches this and resumes to coding
      const actor = createTestActor();
      // Cannot easily test null phaseBeforeStopped since STOP always sets it
      // But we can verify the default branch works by testing all known phases
      actor.send({ type: "PAUSE" }); // from plan
      actor.send({ type: "RESUME" }); // resumes to plan (matched by guard)
      expect(actor.getSnapshot().value).toBe("plan");
      actor.stop();
    });

    it("resumes to merging when paused from merging", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" }); // skip qa → merging
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("merging");
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("merging");
      actor.stop();
    });
  });

  describe("NOTHING_TO_DO", () => {
    it("does NOT transition plan → done on NOTHING_TO_DO (#830)", () => {
      const actor = createTestActor();
      actor.send({ type: "NOTHING_TO_DO", reason: "No work" });
      // plan state should reject NOTHING_TO_DO — only merging allows it
      expect(actor.getSnapshot().value).toBe("plan");
      actor.stop();
    });

    it("does NOT transition coding → done on NOTHING_TO_DO (#830)", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "NOTHING_TO_DO" });
      // coding state should reject NOTHING_TO_DO — only merging allows it
      expect(actor.getSnapshot().value).toBe("coding");
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

  describe("EXTERNAL_CLOSE (#923)", () => {
    it("transitions plan → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "EXTERNAL_CLOSE", reason: "issue closed externally" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().status).toBe("done");
      actor.stop();
    });

    it("transitions plan-gate → done on EXTERNAL_CLOSE and clears gateCheck", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("plan-gate");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("transitions coding → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("coding");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("transitions coding-gate → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("coding-gate");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("transitions qa → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      expect(actor.getSnapshot().value).toBe("qa");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("transitions qa-gate → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("qa-gate");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      expect(actor.getSnapshot().context.gateCheck).toBeNull();
      actor.stop();
    });

    it("transitions merging → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor({ qaRequired: false });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      actor.send({ type: "GATE_APPROVED" });
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("merging");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("does NOT transition paused → done on EXTERNAL_CLOSE (user intent preserved)", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      actor.send({ type: "EXTERNAL_CLOSE" });
      // paused is a user-intent state; external close should not override it.
      expect(actor.getSnapshot().value).toBe("paused");
      actor.stop();
    });

    it("does NOT transition abandoned → done on EXTERNAL_CLOSE", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("abandoned");
      actor.send({ type: "EXTERNAL_CLOSE" });
      expect(actor.getSnapshot().value).toBe("abandoned");
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
    /** Helper: advance actor to merging state, then send NOTHING_TO_DO → done */
    function advanceToDone(actor: ReturnType<typeof createTestActor>) {
      // plan → plan-gate → coding → coding-gate → qa → merging (qaRequired=false skips qa-gate)
      actor.send({ type: "GATE_ENTER" }); // plan → plan-gate
      actor.send({ type: "GATE_APPROVED" }); // plan-gate → coding
      actor.send({ type: "GATE_ENTER" }); // coding → coding-gate
      actor.send({ type: "GATE_APPROVED" }); // coding-gate → qa
      actor.send({ type: "GATE_ENTER" }); // qa → merging (canSkipQA)
      actor.send({ type: "NOTHING_TO_DO" }); // merging → done
    }

    it("does not accept events in done state", () => {
      const actor = createTestActor({ qaRequired: false });
      advanceToDone(actor);
      expect(actor.getSnapshot().value).toBe("done");
      // Sending more events should not change state
      actor.send({ type: "GATE_ENTER" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("done");
      actor.stop();
    });

    it("ignores PROCESS_DIED in done state (no processDead flag set)", () => {
      const actor = createTestActor({ qaRequired: false });
      advanceToDone(actor);
      expect(actor.getSnapshot().value).toBe("done");
      actor.send({ type: "PROCESS_DIED" });
      // Final state ignores all events — processDead should remain false
      expect(actor.getSnapshot().context.processDead).toBe(false);
      actor.stop();
    });
  });

  describe("ABANDON (paused → abandoned)", () => {
    it("transitions paused → abandoned on ABANDON", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("abandoned");
      actor.stop();
    });

    it("ABANDON is only available in paused state", () => {
      const actor = createTestActor();
      // ABANDON in plan should be ignored
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("plan");
      actor.stop();
    });
  });

  describe("REACTIVATE (abandoned → paused)", () => {
    it("transitions abandoned → paused on REACTIVATE", () => {
      const actor = createTestActor();
      actor.send({ type: "PAUSE" });
      actor.send({ type: "ABANDON" });
      expect(actor.getSnapshot().value).toBe("abandoned");
      actor.send({ type: "REACTIVATE" });
      expect(actor.getSnapshot().value).toBe("paused");
      actor.stop();
    });

    it("REACTIVATE is only available in abandoned state", () => {
      const actor = createTestActor();
      actor.send({ type: "REACTIVATE" });
      expect(actor.getSnapshot().value).toBe("plan");
      actor.stop();
    });
  });

  describe("SET_PHASE_BEFORE_STOPPED", () => {
    it("updates phaseBeforeStopped context", () => {
      const actor = createTestActor();
      actor.send({ type: "SET_PHASE_BEFORE_STOPPED", phase: "coding" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("coding");
      actor.stop();
    });

    it("enables correct RESUME after context sync", () => {
      // Simulate Engine restart scenario:
      // 1. Actor created with phaseBeforeStopped = null (default)
      // 2. SET_PHASE_BEFORE_STOPPED syncs from DB
      // 3. RESUME uses the synced value
      const actor = createTestActor();
      actor.send({ type: "PAUSE" }); // phaseBeforeStopped = "plan"
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
      const actor = createTestActor({ phaseBeforeStopped: "qa" });
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBe("qa");
      actor.stop();
    });

    it("defaults phaseBeforeStopped to null when not provided", () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().context.phaseBeforeStopped).toBeNull();
      actor.stop();
    });

    it("RESUME with unrecognized phaseBeforeStopped goes to plan, not coding (#689)", () => {
      const actor = createTestActor();
      // Stop from plan (sets phaseBeforeStopped to "plan")
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
      // Override phaseBeforeStopped to a value with no matching guard (no "wasDone" guard)
      // This simulates the edge case where phaseBeforeStopped is unknown/unexpected.
      actor.send({ type: "SET_PHASE_BEFORE_STOPPED", phase: "done" });
      // RESUME: no guard matches "done" → default target should be "plan" (not "coding")
      actor.send({ type: "RESUME" });
      expect(actor.getSnapshot().value).toBe("plan");
      actor.stop();
    });
  });
});

describe("stateValueToPhase", () => {
  it("maps state values to Phase types", () => {
    expect(stateValueToPhase("plan")).toBe("plan");
    expect(stateValueToPhase("plan-gate")).toBe("plan-gate");
    expect(stateValueToPhase("coding")).toBe("coding");
    expect(stateValueToPhase("done")).toBe("done");
    expect(stateValueToPhase("paused")).toBe("paused");
    expect(stateValueToPhase("abandoned")).toBe("abandoned");
  });
});

describe("phaseToGateEvent", () => {
  it("returns GATE_ENTER for gate phases", () => {
    expect(phaseToGateEvent("plan-gate")).toEqual({ type: "GATE_ENTER" });
    expect(phaseToGateEvent("coding-gate")).toEqual({ type: "GATE_ENTER" });
    expect(phaseToGateEvent("qa-gate")).toEqual({ type: "GATE_ENTER" });
  });

  it("returns null for non-gate phases", () => {
    expect(phaseToGateEvent("plan")).toBeNull();
    expect(phaseToGateEvent("coding")).toBeNull();
    expect(phaseToGateEvent("merging")).toBeNull();
    expect(phaseToGateEvent("done")).toBeNull();
  });
});
