/**
 * Ship/Escort internal API routes: /api/ship/:shipId/*
 *
 * These endpoints are called by Ship and Escort processes (not Frontend).
 * They are scoped by shipId, so fleetId validation is not required.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps, ApiResponse } from "./api-server.js";
import { sendJson, readBody } from "./api-server.js";
import { isGatePhase, GATE_PREV_PHASE, PHASE_ORDER, normalizeGateFeedback } from "./types.js";
import type { Phase, GatePhase } from "./types.js";
import { shouldSkipGate, resolveGateType } from "./gate-config.js";
import { mergeSettings } from "./deep-merge.js";

// ── Comment URL validation ──

const COMMENT_URL_PATTERN = /^https:\/\/github\.com\/.+\/issues\/\d+#issuecomment-\d+$/;

function validateCommentUrl(url: unknown): { valid: true } | { valid: false; error: string } {
  if (!url || typeof url !== "string" || url.trim() === "") {
    return { valid: false, error: "commentUrl is required" };
  }
  if (!COMMENT_URL_PATTERN.test(url)) {
    return { valid: false, error: "commentUrl must match GitHub issue comment URL pattern (https://github.com/.../issues/N#issuecomment-N)" };
  }
  return { valid: true };
}

// ── Escort launch for gate phases ──

/**
 * Launch an Escort for a gate phase. Extracted from the phase-transition handler
 * so it can be reused when a Ship resumes to a gate phase (#853).
 *
 * Handles: gate skip check, skill redeploy, custom instructions, Escort launch,
 * and failure revert. Returns the outcome for the caller.
 */
export async function launchEscortForGate(
  deps: ApiDeps,
  shipId: string,
  gatePhase: GatePhase,
): Promise<{ launched: boolean; escortId?: string; skipped?: boolean; skipPhase?: string; error?: string }> {
  const db = deps.getDatabase();
  const shipManager = deps.getShipManager();
  const actorManager = deps.getActorManager();

  if (!db) {
    return { launched: false, error: "No database" };
  }

  const ship = db.getShipById(shipId);
  if (!ship) {
    return { launched: false, error: `Ship ${shipId} not found` };
  }

  const fleets = await deps.loadFleets();
  const fleet = fleets.find((f) => f.id === ship.fleetId);
  const admiralSettings = await deps.loadAdmiralSettings();
  const mergedGateSettings = mergeSettings(admiralSettings.global, {
    customInstructions: fleet?.customInstructions,
    gates: fleet?.gates,
    gatePrompts: fleet?.gatePrompts,
    qaRequiredPaths: fleet?.qaRequiredPaths,
    acceptanceTestRequired: fleet?.acceptanceTestRequired,
  });
  const refreshedShipForGate = db.getShipById(shipId);
  const skipResult = shouldSkipGate(gatePhase, mergedGateSettings.gates, {
    qaRequired: refreshedShipForGate?.qaRequired ?? true,
  });

  if (skipResult.skip) {
    const { reason } = skipResult;
    console.log(`[ship-internal-api] Gate ${gatePhase} skipped (${reason}) for Ship ${shipId.slice(0, 8)}...`);
    const autoResult = actorManager.requestTransition(shipId, { type: "GATE_APPROVED" });
    if (autoResult.success) {
      const autoSnapshot = actorManager.getPersistedSnapshot(shipId);
      try {
        db.persistPhaseTransition(shipId, autoResult.fromPhase, autoResult.toPhase, "engine", {
          gate_result: "approved",
          feedback: `Escort skipped (${reason})`,
        }, autoSnapshot);
      } catch (err) {
        console.error(`[ship-internal-api] DB persist failed for auto-approve on Ship ${shipId.slice(0, 8)}...:`, err);
      }
      shipManager.syncPhaseFromDb(shipId);
    }
    deps.notifyGateSkip(shipId, gatePhase, reason);
    return { launched: false, skipped: true, skipPhase: autoResult.success ? autoResult.toPhase : gatePhase };
  }

  const gateType = resolveGateType(gatePhase, mergedGateSettings.gates)!;
  shipManager.setGateCheck(shipId, gatePhase, gateType);

  try {
    const { resolveFleetContext } = await import("./api-server.js");
    const fleetCtx = await resolveFleetContext(deps, ship.fleetId);
    const skillSources = typeof fleetCtx === "string" ? undefined : fleetCtx.skillSources;
    await shipManager.redeploySkills(shipId, skillSources);
  } catch (err) {
    console.warn(`[ship-internal-api] Skill redeploy failed for Ship ${shipId.slice(0, 8)}...:`, err);
  }

  const escortManager = deps.getEscortManager();

  let escortExtraPrompt: string | undefined;
  let shipCustomInstructionsText: string | undefined;
  {
    const ci = mergedGateSettings.customInstructions;
    const escortCiParts = [ci?.shared, ci?.escort].filter(Boolean);
    if (escortCiParts.length > 0) {
      escortExtraPrompt = `## Custom Instructions\n\n${escortCiParts.join("\n\n")}`;
    }
    const shipCiParts = [ci?.shared, ci?.ship].filter(Boolean);
    if (shipCiParts.length > 0) {
      shipCustomInstructionsText = `## Custom Instructions\n\n${shipCiParts.join("\n\n")}`;
    }
  }

  const gatePrompt = mergedGateSettings.gatePrompts?.[gateType];

  const escortExtraEnv: Record<string, string> = {};
  if (mergedGateSettings.qaRequiredPaths?.length) {
    escortExtraEnv.VIBE_ADMIRAL_QA_REQUIRED_PATHS = JSON.stringify(mergedGateSettings.qaRequiredPaths);
  }
  const refreshedShip = db.getShipById(shipId);
  if (refreshedShip) {
    escortExtraEnv.VIBE_ADMIRAL_QA_REQUIRED = String(refreshedShip.qaRequired);
  }
  if (gatePhase === "qa-gate" && mergedGateSettings.acceptanceTestRequired === false) {
    escortExtraEnv.VIBE_ADMIRAL_ACCEPTANCE_TEST_REQUIRED = "false";
  }

  const escortId = await escortManager.launchEscort(shipId, gatePhase, gateType, escortExtraPrompt, gatePrompt, shipCustomInstructionsText, escortExtraEnv);
  if (!escortId) {
    const prevPhase = GATE_PREV_PHASE[gatePhase];
    console.error(
      `[ship-internal-api] Escort launch failed for Ship ${shipId.slice(0, 8)}... — reverting from ${gatePhase} to ${prevPhase}`,
    );
    const revertResult = actorManager.requestTransition(shipId, {
      type: "ESCORT_DIED",
      exitCode: null,
      feedback: "Escort launch failed — reverting to pre-gate phase for retry",
    });
    if (revertResult.success) {
      const revertSnapshot = actorManager.getPersistedSnapshot(shipId);
      try {
        db.persistPhaseTransition(shipId, revertResult.fromPhase, revertResult.toPhase, "engine", {
          gate_result: "rejected",
          feedback: "Escort launch failed — reverting to pre-gate phase for retry",
        }, revertSnapshot);
      } catch (revertErr) {
        console.error(`[ship-internal-api] DB persist failed for revert on Ship ${shipId.slice(0, 8)}...:`, revertErr);
      }
      shipManager.syncPhaseFromDb(shipId);
    }
    shipManager.clearGateCheck(shipId);
    escortManager.notifyLaunchFailure(shipId, gatePhase, "Escort launch returned null — reverting to pre-gate phase for retry");
    return { launched: false, error: "Escort launch failed" };
  }

  return { launched: true, escortId };
}

// ── Long-poll infrastructure for gate phase waiting ──

const LONG_POLL_TIMEOUT_MS = 120_000; // 120 seconds

interface PendingLongPoll {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  currentPhase: string;
}

/** shipId → Set of pending long-poll responses waiting for phase change. */
const pendingPhaseWaiters = new Map<string, Set<PendingLongPoll>>();

/**
 * Notify all long-poll waiters for a ship that its phase has changed.
 * Called from ship-lifecycle.ts when a phase transition occurs.
 */
export function notifyPhaseWaiters(shipId: string, newPhase: string): void {
  const waiters = pendingPhaseWaiters.get(shipId);
  if (!waiters || waiters.size === 0) return;

  for (const waiter of waiters) {
    if (waiter.currentPhase !== newPhase) {
      clearTimeout(waiter.timer);
      if (!waiter.res.writableEnded) {
        sendJson(waiter.res, 200, { ok: true, phase: newPhase, timeout: false } as ApiResponse & { timeout: boolean });
      }
      waiters.delete(waiter);
    }
  }
  if (waiters.size === 0) pendingPhaseWaiters.delete(shipId);
}

export async function handleShipRoute(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  shipId: string,
  action: string,
): Promise<void> {
  const db = deps.getDatabase();
  if (!db) {
    sendJson(res, 503, { ok: false, error: "Database not initialized" });
    return;
  }

  const shipManager = deps.getShipManager();

  // GET /api/ship/:shipId/phase — poll current phase
  if (action === "phase" && req.method === "GET") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }
    sendJson(res, 200, { ok: true, phase: ship.phase });
    return;
  }

  // GET /api/ship/:shipId/phase/wait?currentPhase=xxx — long-poll for phase change
  if (action === "phase/wait" && req.method === "GET") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const currentPhase = url.searchParams.get("currentPhase");
    if (!currentPhase) {
      sendJson(res, 400, { ok: false, error: "currentPhase query parameter is required" });
      return;
    }

    if (ship.phase !== currentPhase) {
      sendJson(res, 200, { ok: true, phase: ship.phase, timeout: false } as ApiResponse & { timeout: boolean });
      return;
    }

    const waiter: PendingLongPoll = {
      res,
      currentPhase,
      timer: setTimeout(() => {
        const waiters = pendingPhaseWaiters.get(shipId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) pendingPhaseWaiters.delete(shipId);
        }
        if (!res.writableEnded) {
          const freshShip = db.getShipById(shipId);
          const phase = freshShip?.phase ?? currentPhase;
          sendJson(res, 200, { ok: true, phase, timeout: true } as ApiResponse & { timeout: boolean });
        }
      }, LONG_POLL_TIMEOUT_MS),
    };

    if (!pendingPhaseWaiters.has(shipId)) {
      pendingPhaseWaiters.set(shipId, new Set());
    }
    pendingPhaseWaiters.get(shipId)!.add(waiter);

    req.on("close", () => {
      clearTimeout(waiter.timer);
      const waiters = pendingPhaseWaiters.get(shipId);
      if (waiters) {
        waiters.delete(waiter);
        if (waiters.size === 0) pendingPhaseWaiters.delete(shipId);
      }
    });

    return;
  }

  // GET /api/ship/:shipId/phase-transition-log — get recent phase transitions
  if (action === "phase-transition-log" && req.method === "GET") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 100);
    const transitions = db.getPhaseTransitions(shipId, limit);
    sendJson(res, 200, { ok: true, transitions });
    return;
  }

  // DELETE /api/ship/:shipId/delete — Force-delete a Ship (zombie cleanup)
  if (action === "delete" && req.method === "DELETE") {
    const deleted = shipManager.deleteShip(shipId);
    if (deleted) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
    }
    return;
  }

  // GET /api/ship/:shipId/escort-usage — Escort token usage for a Ship (#800)
  if (action === "escort-usage" && req.method === "GET") {
    const usage = db.getEscortUsageByShipId(shipId);
    if (!usage) {
      sendJson(res, 404, { ok: false, error: `No Escort found for Ship ${shipId}` });
      return;
    }
    sendJson(res, 200, { ok: true, ...usage });
    return;
  }

  // POST-only routes below
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const rawBody = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  // POST /api/ship/:shipId/phase-transition — Ship transitions its own phase
  if (action === "phase-transition") {
    const targetPhase = body.phase as string | undefined;
    if (!targetPhase) {
      sendJson(res, 400, { ok: false, error: "phase is required" });
      return;
    }
    if (!PHASE_ORDER.includes(targetPhase as Phase)) {
      sendJson(res, 400, { ok: false, error: `Invalid phase: ${targetPhase}` });
      return;
    }

    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const metadata = (body.metadata as Record<string, unknown>) ?? {};
    const triggeredBy = (body.triggeredBy as string) ?? "ship";

    // commentUrl is required for Ship-initiated transitions (not Engine-internal ones)
    if (triggeredBy !== "engine") {
      const commentUrlResult = validateCommentUrl(body.commentUrl);
      if (!commentUrlResult.valid) {
        sendJson(res, 400, { ok: false, error: commentUrlResult.error });
        return;
      }
      metadata.commentUrl = body.commentUrl as string;
    }

    if (targetPhase === "plan-gate" && typeof metadata.qaRequired === "boolean") {
      shipManager.setQaRequired(shipId, metadata.qaRequired);
    }

    if (targetPhase === "qa-gate") {
      const currentShip = db.getShipById(shipId);
      if (currentShip && !currentShip.qaRequired) {
        const fleets = await deps.loadFleets();
        const fleet = fleets.find((f) => f.id === currentShip.fleetId);
        if (fleet?.qaRequiredPaths?.length) {
          try {
            const { execSync } = await import("node:child_process");
            const changedFiles = execSync("git diff --name-only main...HEAD", {
              cwd: currentShip.worktreePath,
              encoding: "utf-8",
              timeout: 10000,
            }).trim().split("\n").filter(Boolean);

            const { matchesGlob } = await import("node:path");
            const hasMatch = changedFiles.some((file) =>
              fleet.qaRequiredPaths!.some((pattern) => matchesGlob(file, pattern))
            );
            if (hasMatch) {
              console.log(
                `[ship-internal-api] qaRequiredPaths match found for Ship ${shipId.slice(0, 8)}... — overriding qaRequired to true`,
              );
              shipManager.setQaRequired(shipId, true);
            }
          } catch (err) {
            console.warn(`[ship-internal-api] Failed to check qaRequiredPaths for Ship ${shipId.slice(0, 8)}...:`, err);
          }
        }
      }
    }

    const actorManager = deps.getActorManager();
    let xstateEvent: import("./ship-machine.js").ShipMachineEvent;
    if (isGatePhase(targetPhase as Phase)) {
      xstateEvent = { type: "GATE_ENTER" };
    } else if (targetPhase === "done") {
      xstateEvent = { type: "COMPLETE" };
    } else {
      sendJson(res, 400, { ok: false, error: `Ships can only transition to gate phases or done, not ${targetPhase}` });
      return;
    }

    const dbPhase = ship.phase as Phase;
    if (!actorManager.assertPhaseConsistency(shipId, dbPhase)) {
      console.warn(`[ship-internal-api] Pre-transition reconciliation for Ship ${shipId.slice(0, 8)}...`);
      actorManager.reconcilePhase(shipId, dbPhase);
    }

    const result = actorManager.requestTransition(shipId, xstateEvent);
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Transition rejected by XState: current phase is ${result.currentPhase ?? "unknown"}, cannot process ${xstateEvent.type}` });
      return;
    }

    const actorSnapshot = actorManager.getPersistedSnapshot(shipId);
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
      console.error(`[ship-internal-api] DB persist failed after XState transition for Ship ${shipId.slice(0, 8)}... — reverting XState`, err);
      actorManager.reconcilePhase(shipId, result.fromPhase);
      sendJson(res, 500, { ok: false, error: "Phase transition failed: DB persist error" });
      return;
    }

    shipManager.syncPhaseFromDb(shipId);

    if (isGatePhase(result.toPhase)) {
      const gateResult = await launchEscortForGate(deps, shipId, result.toPhase as GatePhase);

      if (gateResult.skipped) {
        // Gate was auto-approved (skip). Phase already advanced by launchEscortForGate.
        sendJson(res, 200, { ok: true, phase: gateResult.skipPhase ?? result.toPhase });
        return;
      }

      if (!gateResult.launched) {
        sendJson(res, 500, { ok: false, error: gateResult.error ?? "Escort launch failed — phase reverted to allow retry" });
        return;
      }
    }

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/gate-intent
  if (action === "gate-intent") {
    const verdict = body.verdict as string | undefined;
    if (verdict !== "approve" && verdict !== "reject") {
      sendJson(res, 400, { ok: false, error: 'verdict must be "approve" or "reject"' });
      return;
    }

    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const escortManager = deps.getEscortManager();
    const intentFeedback = normalizeGateFeedback(body.feedback as Parameters<typeof normalizeGateFeedback>[0]);
    escortManager.setGateIntent(shipId, {
      verdict,
      feedback: intentFeedback,
      declaredAt: new Date().toISOString(),
    });

    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/ship/:shipId/gate-verdict
  if (action === "gate-verdict") {
    const verdict = body.verdict as string | undefined;
    if (verdict !== "approve" && verdict !== "reject") {
      sendJson(res, 400, { ok: false, error: 'verdict must be "approve" or "reject"' });
      return;
    }

    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const currentPhase = ship.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      sendJson(res, 400, { ok: false, error: `Ship is not in a gate phase (current: ${currentPhase})` });
      return;
    }

    // commentUrl is required for Escort-submitted verdicts
    const commentUrlResult = validateCommentUrl(body.commentUrl);
    if (!commentUrlResult.valid) {
      sendJson(res, 400, { ok: false, error: commentUrlResult.error });
      return;
    }

    const rawFeedback = body.feedback as string | Record<string, unknown> | undefined;
    const structuredFeedback = normalizeGateFeedback(rawFeedback as Parameters<typeof normalizeGateFeedback>[0]);

    const actorManager = deps.getActorManager();

    if (!actorManager.assertPhaseConsistency(shipId, currentPhase)) {
      console.warn(`[ship-internal-api] Pre-verdict reconciliation for Ship ${shipId.slice(0, 8)}...`);
      actorManager.reconcilePhase(shipId, currentPhase);
    }

    const xstateEvent: import("./ship-machine.js").ShipMachineEvent = verdict === "approve"
      ? { type: "GATE_APPROVED" }
      : { type: "GATE_REJECTED", feedback: structuredFeedback ?? "" };

    const result = actorManager.requestTransition(shipId, xstateEvent);
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Gate verdict rejected by XState: current phase is ${result.currentPhase ?? "unknown"}` });
      return;
    }

    const metadata: Record<string, unknown> = verdict === "approve"
      ? { gate_result: "approved", commentUrl: body.commentUrl }
      : { gate_result: "rejected", feedback: structuredFeedback ?? "", commentUrl: body.commentUrl };

    const verdictSnapshot = actorManager.getPersistedSnapshot(shipId);
    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "escort", metadata, verdictSnapshot);
    } catch (err) {
      console.error(`[ship-internal-api] DB persist failed after gate verdict for Ship ${shipId.slice(0, 8)}... — reverting XState`, err);
      actorManager.reconcilePhase(shipId, result.fromPhase);
      sendJson(res, 500, { ok: false, error: "Gate verdict failed: DB persist error" });
      return;
    }

    shipManager.syncPhaseFromDb(shipId);
    shipManager.clearGateCheck(shipId);

    const escortMgr = deps.getEscortManager();
    escortMgr.clearGateIntent(shipId);

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/nothing-to-do
  if (action === "nothing-to-do") {
    const reason = (body.reason as string) ?? "No reason provided";
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const actorManager = deps.getActorManager();
    const result = actorManager.requestTransition(shipId, { type: "NOTHING_TO_DO", reason });
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Nothing-to-do rejected by XState: current phase is ${result.currentPhase ?? "unknown"}` });
      return;
    }

    const nothingToDoSnapshot = actorManager.getPersistedSnapshot(shipId);
    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "ship", { reason, nothingToDo: true }, nothingToDoSnapshot);
    } catch (err) {
      console.error(`[ship-internal-api] DB persist failed after nothing-to-do for Ship ${shipId.slice(0, 8)}...:`, err);
    }

    shipManager.syncPhaseFromDb(shipId);
    sendJson(res, 200, { ok: true, phase: "done" });
    return;
  }

  // POST /api/ship/:shipId/abandon
  if (action === "abandon") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    if (ship.phase !== "paused") {
      sendJson(res, 400, { ok: false, error: `Ship must be in "paused" phase to abandon (current: ${ship.phase})` });
      return;
    }

    const abandoned = shipManager.abandonShip(shipId);
    if (abandoned) {
      sendJson(res, 200, { ok: true, phase: "abandoned" });
    } else {
      sendJson(res, 400, { ok: false, error: "Failed to abandon ship" });
    }
    return;
  }

  // POST /api/ship/:shipId/reactivate
  if (action === "reactivate") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    if (ship.phase !== "abandoned") {
      sendJson(res, 400, { ok: false, error: `Ship must be in "abandoned" phase to reactivate (current: ${ship.phase})` });
      return;
    }

    const reactivated = shipManager.reactivateShip(shipId);
    if (reactivated) {
      sendJson(res, 200, { ok: true, phase: "paused" });
    } else {
      sendJson(res, 400, { ok: false, error: "Failed to reactivate ship" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown ship action: ${action}` });
}
