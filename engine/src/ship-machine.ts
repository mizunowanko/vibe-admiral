/**
 * XState v5 Ship State Machine
 *
 * Formalizes the Ship lifecycle as a state machine:
 *   planning → planning-gate → implementing → implementing-gate
 *   → acceptance-test → acceptance-test-gate → merging → done
 *
 * Gate states auto-trigger Escort launch via entry actions.
 * The "stopped" state preserves the previous phase for resume.
 *
 * @see https://stately.ai/docs/machines
 */
import { setup, assign } from "xstate";
import type { Phase, GatePhase, GateCheckState, PRReviewStatus } from "./types.js";
import { DEFAULT_GATE_TYPES } from "./types.js";

// === Context ===

export interface ShipMachineContext {
  shipId: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  worktreePath: string;
  branchName: string;
  sessionId: string | null;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  gateCheck: GateCheckState | null;
  retryCount: number;
  lastOutputAt: number | null;
  isCompacting: boolean;
  processDead: boolean;
  /** Phase before entering "stopped" — used to resume to the correct state. */
  phaseBeforeStopped: Phase | null;
  /** Whether QA (acceptance-test-gate) is required. Determined during planning. */
  qaRequired: boolean;
}

// === Events ===

export type ShipMachineEvent =
  | { type: "GATE_ENTER" }
  | { type: "GATE_APPROVED" }
  | { type: "GATE_REJECTED"; feedback?: string }
  | { type: "ESCORT_DIED"; exitCode: number | null; feedback?: string }
  | { type: "COMPLETE" }
  | { type: "STOP" }
  | { type: "RESUME" }
  | { type: "ABANDON" }
  | { type: "PROCESS_DIED" }
  | { type: "PROCESS_OUTPUT"; timestamp: number }
  | { type: "COMPACT_START" }
  | { type: "COMPACT_END" }
  | { type: "NOTHING_TO_DO"; reason?: string }
  | { type: "SET_SESSION_ID"; sessionId: string }
  | { type: "SET_PR_URL"; prUrl: string }
  | { type: "SET_QA_REQUIRED"; qaRequired: boolean }
  | { type: "SET_PR_REVIEW_STATUS"; status: PRReviewStatus }
  | { type: "SET_PHASE_BEFORE_STOPPED"; phase: Phase };

// === Input (for actor creation) ===

export interface ShipMachineInput {
  shipId: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  worktreePath: string;
  branchName: string;
  sessionId?: string | null;
  prUrl?: string | null;
  qaRequired?: boolean;
  phaseBeforeStopped?: Phase | null;
}

// === Helper: Create GateCheckState ===

function makeGateCheck(gatePhase: GatePhase): GateCheckState {
  return {
    gatePhase,
    gateType: DEFAULT_GATE_TYPES[gatePhase],
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
}

// === Machine Definition ===

export const shipMachine = setup({
  types: {
    context: {} as ShipMachineContext,
    events: {} as ShipMachineEvent,
    input: {} as ShipMachineInput,
  },
  actions: {
    clearGateCheck: assign({ gateCheck: () => null as GateCheckState | null }),
  },
  guards: {
    canSkipQA: ({ context }) => !context.qaRequired,
    wasPlanning: ({ context }) => context.phaseBeforeStopped === "planning",
    wasPlanningGate: ({ context }) => context.phaseBeforeStopped === "planning-gate",
    wasImplementing: ({ context }) => context.phaseBeforeStopped === "implementing",
    wasImplementingGate: ({ context }) => context.phaseBeforeStopped === "implementing-gate",
    wasAcceptanceTest: ({ context }) => context.phaseBeforeStopped === "acceptance-test",
    wasAcceptanceTestGate: ({ context }) => context.phaseBeforeStopped === "acceptance-test-gate",
    wasMerging: ({ context }) => context.phaseBeforeStopped === "merging",
  },
}).createMachine({
  id: "ship",
  context: ({ input }) => ({
    shipId: input.shipId,
    fleetId: input.fleetId,
    repo: input.repo,
    issueNumber: input.issueNumber,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    sessionId: input.sessionId ?? null,
    prUrl: input.prUrl ?? null,
    prReviewStatus: null,
    gateCheck: null,
    retryCount: 0,
    lastOutputAt: null,
    isCompacting: false,
    processDead: false,
    phaseBeforeStopped: input.phaseBeforeStopped ?? null,
    qaRequired: input.qaRequired ?? true,
  }),
  initial: "planning",
  // Global events available in all states
  on: {
    PROCESS_OUTPUT: {
      actions: assign({
        lastOutputAt: ({ event }) => event.timestamp,
        processDead: () => false,
      }),
    },
    COMPACT_START: {
      actions: assign({ isCompacting: () => true }),
    },
    COMPACT_END: {
      actions: assign({ isCompacting: () => false }),
    },
    SET_SESSION_ID: {
      actions: assign({ sessionId: ({ event }) => event.sessionId }),
    },
    SET_PR_URL: {
      actions: assign({ prUrl: ({ event }) => event.prUrl }),
    },
    SET_QA_REQUIRED: {
      actions: assign({ qaRequired: ({ event }) => event.qaRequired }),
    },
    SET_PR_REVIEW_STATUS: {
      actions: assign({ prReviewStatus: ({ event }) => event.status }),
    },
    PROCESS_DIED: {
      actions: assign({ processDead: () => true }),
    },
    SET_PHASE_BEFORE_STOPPED: {
      actions: assign({
        phaseBeforeStopped: ({ event }) => event.phase,
      }),
    },
  },
  states: {
    planning: {
      on: {
        GATE_ENTER: { target: "planning-gate" },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "planning",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "planning-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("planning-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "implementing",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "planning",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "planning",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "planning-gate",
          }),
        },
      },
    },

    implementing: {
      on: {
        GATE_ENTER: { target: "implementing-gate" },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "implementing",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "implementing-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("implementing-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "acceptance-test",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "implementing",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "implementing",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "implementing-gate",
          }),
        },
      },
    },

    "acceptance-test": {
      on: {
        GATE_ENTER: [
          {
            target: "merging",
            guard: "canSkipQA",
          },
          { target: "acceptance-test-gate" },
        ],
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "acceptance-test",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "acceptance-test-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("acceptance-test-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "merging",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "acceptance-test",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "acceptance-test",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "acceptance-test-gate",
          }),
        },
      },
    },

    merging: {
      on: {
        COMPLETE: { target: "done" },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "merging",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    done: {
      // Final state — XState v5 ignores all events (including global PROCESS_DIED).
      // Process death after completion is handled by ShipManager.notifyProcessDead()
      // which skips ships in "done" phase.
      type: "final",
    },

    stopped: {
      on: {
        ABANDON: {
          target: "done",
        },
        RESUME: [
          {
            target: "planning",
            guard: "wasPlanning",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "planning-gate",
            guard: "wasPlanningGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "implementing",
            guard: "wasImplementing",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "implementing-gate",
            guard: "wasImplementingGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "acceptance-test",
            guard: "wasAcceptanceTest",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "acceptance-test-gate",
            guard: "wasAcceptanceTestGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            target: "merging",
            guard: "wasMerging",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
          {
            // Default: resume to implementing if phaseBeforeStopped is unknown
            target: "implementing",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
            }),
          },
        ],
      },
    },
  },
});

// === Type exports for external consumers ===

export type ShipMachine = typeof shipMachine;

/** Map XState state value to Phase type. */
export function stateValueToPhase(stateValue: string): Phase {
  return stateValue as Phase;
}

/** Map Phase to XState event for entering a gate. */
export function phaseToGateEvent(phase: Phase): ShipMachineEvent | null {
  switch (phase) {
    case "planning-gate":
    case "implementing-gate":
    case "acceptance-test-gate":
      return { type: "GATE_ENTER" };
    default:
      return null;
  }
}
