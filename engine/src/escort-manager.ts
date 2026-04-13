import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadUnitPrompt } from "./prompt-loader.js";
import type { ProcessManagerLike } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { PhaseTransactionService } from "./phase-transaction-service.js";
import type { EscortProcess, GatePhase, GateType, GateIntent, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";
import { safeJsonParse } from "./util/json-safe.js";
import { EscortFilesystemManager } from "./escort-filesystem-manager.js";

const GATE_PHASE_SKILL: Record<GatePhase, string> = {
  "plan-gate": "/escort-planning-gate",
  "coding-gate": "/escort-implementing-gate",
  "qa-gate": "/escort-acceptance-test-gate",
};

export class EscortManager {
  private processManager: ProcessManagerLike;
  private shipManager: ShipManager;
  private getDatabase: () => FleetDatabase | null;
  private actorManager: ShipActorManager | null = null;
  private phaseTx: PhaseTransactionService | null = null;
  private escorts = new Map<string, string>();
  private fs: EscortFilesystemManager;
  private onEscortDeathCallback: ((shipId: string, message: string) => void) | null = null;

  constructor(processManager: ProcessManagerLike, shipManager: ShipManager, getDatabase: () => FleetDatabase | null) {
    this.processManager = processManager;
    this.shipManager = shipManager;
    this.getDatabase = getDatabase;
    this.fs = new EscortFilesystemManager();
  }

  setActorManager(actorManager: ShipActorManager): void {
    this.actorManager = actorManager;
  }

  setPhaseTransactionService(phaseTx: PhaseTransactionService): void {
    this.phaseTx = phaseTx;
  }

  setEscortDeathHandler(handler: (shipId: string, message: string) => void): void {
    this.onEscortDeathCallback = handler;
  }

  setGateIntent(parentShipId: string, intent: GateIntent): void {
    const db = this.getDatabase();
    if (db) {
      const feedbackStr = intent.feedback ? (typeof intent.feedback === "string" ? intent.feedback : JSON.stringify(intent.feedback)) : undefined;
      db.setGateIntent(parentShipId, intent.verdict, feedbackStr);
    }
    console.log(
      `[escort-manager] Gate intent declared for Ship ${parentShipId.slice(0, 8)}...: ${intent.verdict}`,
    );
  }

  getGateIntent(parentShipId: string): GateIntent | undefined {
    const db = this.getDatabase();
    if (!db) return undefined;
    const row = db.getGateIntent(parentShipId);
    if (!row) return undefined;
    return {
      verdict: row.verdict,
      feedback: row.feedback ?? undefined,
      declaredAt: row.declaredAt,
    };
  }

  clearGateIntent(parentShipId: string): void {
    const db = this.getDatabase();
    if (db) db.clearGateIntent(parentShipId);
  }

  async launchEscort(
    parentShipId: string,
    gatePhase?: GatePhase,
    _gateType?: GateType,
    extraPrompt?: string,
    gatePrompt?: string,
    shipCustomInstructionsText?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string | null> {
    await this.fs.awaitPendingCleanup(parentShipId);

    const existingEscortId = this.escorts.get(parentShipId);
    if (existingEscortId && this.processManager.isRunning(existingEscortId)) {
      console.log(
        `[escort-manager] Escort already running for Ship ${parentShipId.slice(0, 8)}... (${existingEscortId.slice(0, 8)}...)`,
      );
      return null;
    }

    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) {
      console.warn(`[escort-manager] Parent Ship ${parentShipId} not found — cannot launch Escort`);
      return null;
    }

    const db = this.getDatabase();

    this.fs.storeShipCustomInstructions(parentShipId, shipCustomInstructionsText);

    try {
      const existingEscort = db?.getEscortByShipId(parentShipId);

      if (existingEscort?.sessionId) {
        try {
          const escortId = await this.resumeEscort(existingEscort, parentShip, gatePhase ?? "plan-gate", extraPrompt, gatePrompt, extraEnv);
          this.escorts.set(parentShipId, escortId);

          console.log(
            `[escort-manager] Resumed Escort ${escortId.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate`,
          );

          return escortId;
        } catch (resumeErr) {
          console.warn(
            `[escort-manager] Resume failed for Escort ${existingEscort.id.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) — falling back to fresh sortie. Error:`,
            resumeErr,
          );
          db?.updateEscortSessionId(existingEscort.id, null);
        }
      }

      const escortId = await this.sortieEscort(parentShip, gatePhase, extraPrompt, gatePrompt, extraEnv);
      this.escorts.set(parentShipId, escortId);

      console.log(
        `[escort-manager] Launched new Escort ${escortId.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate (issue #${parentShip.issueNumber})`,
      );

      return escortId;
    } catch (err) {
      console.error(`[escort-manager] Failed to launch Escort for Ship ${parentShipId.slice(0, 8)}...:`, err);
      return null;
    }
  }

  notifyLaunchFailure(parentShipId: string, gatePhase: GatePhase, reason: string): void {
    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) return;

    const prevPhase = GATE_PREV_PHASE[gatePhase];
    const message = `Escort launch failed for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) at ${gatePhase}: ${reason}. Phase reverted to ${prevPhase}.`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  private async sortieEscort(
    parentShip: { id: string; repo: string; issueNumber: number; worktreePath: string },
    gatePhase?: GatePhase,
    extraPrompt?: string,
    gatePrompt?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const escortId = randomUUID();
    const db = this.getDatabase();

    const escort: EscortProcess = {
      id: escortId,
      shipId: parentShip.id,
      sessionId: null,
      processPid: null,
      phase: "plan",
      createdAt: new Date().toISOString(),
      completedAt: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      costUsd: null,
    };

    if (db) {
      db.upsertEscort(escort);
    }

    await this.fs.deployCustomInstructions(parentShip.worktreePath, extraPrompt);
    await this.fs.stashForEscort(parentShip.worktreePath);

    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
      ...extraEnv,
    };

    const gateContext = gatePhase
      ? `\n\n${loadUnitPrompt("escort", { gatePhase })}`
      : "";

    const skill = gatePhase ? GATE_PHASE_SKILL[gatePhase] : "/escort-planning-gate";

    this.processManager.sortie(
      escortId,
      parentShip.worktreePath,
      parentShip.issueNumber,
      [extraPrompt, gateContext].filter(Boolean).join("\n\n") || undefined,
      skill,
      escortEnv,
    );

    return escortId;
  }

  private async resumeEscort(
    existingEscort: EscortProcess,
    parentShip: { id: string; repo: string; worktreePath: string },
    gatePhase: GatePhase,
    extraPrompt?: string,
    gatePrompt?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    if (!existingEscort.sessionId) {
      throw new Error(`Cannot resume Escort ${existingEscort.id.slice(0, 8)}... — no sessionId`);
    }

    const escortId = existingEscort.id;

    await this.fs.deployCustomInstructions(parentShip.worktreePath, extraPrompt);
    await this.fs.stashForEscort(parentShip.worktreePath);

    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
      ...extraEnv,
    };

    const resumeMessage = `The parent Ship has entered ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`;

    this.processManager.resumeSession(
      escortId,
      existingEscort.sessionId,
      resumeMessage,
      parentShip.worktreePath,
      escortEnv,
      extraPrompt,
      "escort-log.jsonl",
    );

    return escortId;
  }

  isEscortRunning(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      const db = this.getDatabase();
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        this.escorts.set(parentShipId, escort.id);
        return this.processManager.isRunning(escort.id);
      }
      return false;
    }
    return this.processManager.isRunning(escortId);
  }

  killEscort(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) return false;
    const killed = this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);
    return killed;
  }

  cleanupForDoneShip(parentShipId: string): void {
    const db = this.getDatabase();

    let escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        escortId = escort.id;
      }
    }
    if (!escortId) return;

    this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);

    db?.updateEscortPhase(escortId, "done", new Date().toISOString());

    console.log(
      `[escort-manager] Cleaned up Escort ${escortId.slice(0, 8)}... for done Ship ${parentShipId.slice(0, 8)}...`,
    );
  }

  isEscortProcess(processId: string): boolean {
    for (const escortId of this.escorts.values()) {
      if (escortId === processId) return true;
    }
    const db = this.getDatabase();
    const escort = db?.getEscortById(processId);
    return escort !== undefined;
  }

  findShipIdByEscortId(escortShipId: string): string | undefined {
    for (const [parentId, escortId] of this.escorts) {
      if (escortId === escortShipId) return parentId;
    }
    const db = this.getDatabase();
    const escort = db?.getEscortById(escortShipId);
    if (escort) {
      this.escorts.set(escort.shipId, escortShipId);
      return escort.shipId;
    }
    return undefined;
  }

  setEscortSessionId(escortId: string, sessionId: string): void {
    const db = this.getDatabase();
    db?.updateEscortSessionId(escortId, sessionId);
  }

  async onEscortExit(escortShipId: string, code: number | null): Promise<void> {
    const parentShipId = this.findShipIdByEscortId(escortShipId);
    if (!parentShipId) return;

    {
      const ship = this.shipManager.getShip(parentShipId);
      this.fs.startCleanup(parentShipId, ship?.worktreePath);
    }

    this.escorts.delete(parentShipId);

    console.log(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... exited (code=${code}) for parent Ship ${parentShipId.slice(0, 8)}...`,
    );

    const db = this.getDatabase();
    if (!db) return;

    const parentShip = db.getShipById(parentShipId);
    if (!parentShip) return;

    const currentPhase = parentShip.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      this.shipManager.clearGateCheck(parentShipId);
      this.clearGateIntent(parentShipId);
      return;
    }

    {
      const ship = this.shipManager.getShip(parentShipId);
      if (ship) {
        const logPath = join(ship.worktreePath, ".claude", "escort-log.jsonl");
        try {
          const content = await readFile(logPath, "utf-8");
          const lines = content.trim().split("\n").slice(-10);
          const lastMessages = lines
            .map((l) => safeJsonParse<Record<string, unknown>>(l, { source: "escort.lastLog" }))
            .filter((m): m is Record<string, unknown> => m != null)
            .filter((m) => m.type === "assistant" || m.type === "result")
            .map((m) => {
              if (m.type === "result") return `[result] costUsd=${m.costUsd as number | undefined}`;
              return `[assistant] ${(String(m.message ?? "")).slice(0, 200)}`;
            });
          if (lastMessages.length > 0) {
            console.warn(
              `[escort-manager] Escort ${escortShipId.slice(0, 8)}... last log entries:\n${lastMessages.join("\n")}`,
            );
          }
        } catch {
          // log file may not exist
        }
      }
    }

    const intent = this.getGateIntent(parentShipId);
    this.clearGateIntent(parentShipId);

    if (intent?.verdict === "approve" && this.phaseTx) {
      console.log(
        `[escort-manager] Escort ${escortShipId.slice(0, 8)}... died without verdict, but gate-intent was "approve" — auto-approving for Ship ${parentShipId.slice(0, 8)}...`,
      );

      const approveResult = this.phaseTx.commit(parentShipId, {
        event: { type: "GATE_APPROVED" },
        triggeredBy: "escort",
        metadata: {
          gate_result: "approved",
          fallback: true,
          reason: `Escort died (code=${code}) but had declared approve intent — auto-approved`,
        },
      });

      if (approveResult.success) {
        return;
      }
      console.warn(
        `[escort-manager] Fallback GATE_APPROVED failed for Ship ${parentShipId.slice(0, 8)}...: ${approveResult.error} — falling through to revert`,
      );
    }

    const prevPhase = GATE_PREV_PHASE[currentPhase as GatePhase];
    console.warn(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... died without verdict — reverting Ship ${parentShipId.slice(0, 8)}... from ${currentPhase} to ${prevPhase}`,
    );

    const feedback = `Escort process exited unexpectedly (code=${code}) without submitting verdict`;
    if (this.phaseTx) {
      const result = this.phaseTx.commit(parentShipId, {
        event: { type: "ESCORT_DIED", exitCode: code, feedback },
        triggeredBy: "escort",
        metadata: { gate_result: "rejected", feedback },
      });
      if (!result.success) {
        console.error(`[escort-manager] Phase revert failed for Ship ${parentShipId.slice(0, 8)}...: ${result.error}`);
      }
    }

    const MAX_ESCORT_FAILS = 3;
    const context = this.actorManager?.getContext(parentShipId);
    if (context && context.escortFailCount >= MAX_ESCORT_FAILS) {
      console.error(
        `[escort-manager] Ship #${parentShip.issueNumber} (${parentShipId.slice(0, 8)}...) hit Escort fail limit ` +
        `(${context.escortFailCount}/${MAX_ESCORT_FAILS} consecutive failures) — auto-stopping to prevent infinite loop`,
      );
      this.actorManager?.send(parentShipId, { type: "PAUSE" });
      this.actorManager?.send(parentShipId, { type: "ESCORT_FAIL_LIMIT" });
      this.shipManager.updatePhase(parentShipId, "paused", `Auto-paused: ${MAX_ESCORT_FAILS} consecutive Escort failures in ${currentPhase}`);

      const stopMessage = `Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) auto-paused: ${MAX_ESCORT_FAILS} consecutive Escort failures in ${currentPhase}. Manual intervention required.`;
      this.onEscortDeathCallback?.(parentShipId, stopMessage);
      return;
    }

    const message = `Escort died without verdict for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) during ${currentPhase}. Phase reverted to ${prevPhase}. (exit code=${code})`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  killAll(): void {
    for (const [parentShipId, escortId] of this.escorts) {
      this.processManager.kill(escortId);
      this.escorts.delete(parentShipId);
    }
  }
}
