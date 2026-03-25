/**
 * XState v5 Ship State Machine
 *
 * Formalizes the Ship lifecycle as a state machine:
 *   plan → plan-gate → coding → coding-gate
 *   → qa → qa-gate → merging → done
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
  /** Whether QA (qa-gate) is required. Determined during planning. */
  qaRequired: boolean;
  /** Timestamp (ms epoch) when the Ship process was last started/resumed. Used for rapid death detection. */
  lastStartedAt: number | null;
  /** Count of consecutive rapid deaths (process exiting within RAPID_DEATH_THRESHOLD_MS of start). */
  rapidDeathCount: number;
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
  | { type: "SET_PHASE_BEFORE_STOPPED"; phase: Phase }
  | { type: "RAPID_DEATH_LIMIT" };

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
    wasPlan: ({ context }) => context.phaseBeforeStopped === "plan",
    wasPlanGate: ({ context }) => context.phaseBeforeStopped === "plan-gate",
    wasCoding: ({ context }) => context.phaseBeforeStopped === "coding",
    wasCodingGate: ({ context }) => context.phaseBeforeStopped === "coding-gate",
    wasQA: ({ context }) => context.phaseBeforeStopped === "qa",
    wasQAGate: ({ context }) => context.phaseBeforeStopped === "qa-gate",
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
    lastStartedAt: null,
    rapidDeathCount: 0,
  }),
  initial: "plan",
  // Global events available in all states
  on: {
    PROCESS_OUTPUT: {
      actions: assign({
        lastOutputAt: ({ event }) => event.timestamp,
        processDead: () => false,
        rapidDeathCount: () => 0,
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
    plan: {
      on: {
        GATE_ENTER: { target: "plan-gate" },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "plan",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "plan-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("plan-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "coding",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "plan",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "plan",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "plan-gate",
          }),
        },
      },
    },

    coding: {
      on: {
        GATE_ENTER: { target: "coding-gate" },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "coding",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "coding-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("coding-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "qa",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "coding",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "coding",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "coding-gate",
          }),
        },
      },
    },

    qa: {
      on: {
        GATE_ENTER: [
          {
            target: "merging",
            guard: "canSkipQA",
          },
          { target: "qa-gate" },
        ],
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "qa",
          }),
        },
        NOTHING_TO_DO: { target: "done" },
      },
    },

    "qa-gate": {
      entry: assign({
        gateCheck: () => makeGateCheck("qa-gate"),
      }),
      on: {
        GATE_APPROVED: {
          target: "merging",
          actions: "clearGateCheck",
        },
        GATE_REJECTED: {
          target: "qa",
          actions: "clearGateCheck",
        },
        ESCORT_DIED: {
          target: "qa",
          actions: "clearGateCheck",
        },
        STOP: {
          target: "stopped",
          actions: assign({
            phaseBeforeStopped: (): Phase | null => "qa-gate",
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
        RAPID_DEATH_LIMIT: {
          // Auto-stop: too many rapid deaths detected by Engine
        },
        RESUME: [
          {
            target: "plan",
            guard: "wasPlan",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "plan-gate",
            guard: "wasPlanGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "coding",
            guard: "wasCoding",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "coding-gate",
            guard: "wasCodingGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "qa",
            guard: "wasQA",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "qa-gate",
            guard: "wasQAGate",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            target: "merging",
            guard: "wasMerging",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
            }),
          },
          {
            // Default: resume to coding if phaseBeforeStopped is unknown
            target: "coding",
            actions: assign({
              processDead: () => false,
              retryCount: ({ context }) => context.retryCount + 1,
              lastStartedAt: () => Date.now(),
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
    case "plan-gate":
    case "coding-gate":
    case "qa-gate":
      return { type: "GATE_ENTER" };
    default:
      return null;
  }
}
