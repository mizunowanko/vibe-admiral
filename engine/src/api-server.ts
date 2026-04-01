import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { FlagshipRequestHandler } from "./bridge-request-handler.js";
import type { FleetDatabase } from "./db.js";
import type { ShipManager } from "./ship-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { DispatchManager } from "./dispatch-manager.js";
import type { FlagshipRequest, FleetRepo, FleetSkillSources, CustomInstructions, Phase, GatePhase, DispatchType, CommanderRole, AdmiralSettings, HeadsUpNotification, HeadsUpSeverity, ResumeAllUnitResult } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE, PHASE_ORDER, normalizeGateFeedback } from "./types.js";
import { resolveGateType } from "./gate-config.js";
import { mergeSettings } from "./deep-merge.js";

/** Admiral repo's skills/ directory, resolved from Engine's own source location. */
const ADMIRAL_SKILLS_DIR = join(import.meta.dirname, "..", "..", "skills");

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

interface ApiDeps {
  requestHandler: FlagshipRequestHandler;
  getDatabase: () => FleetDatabase | null;
  getShipManager: () => ShipManager;
  getDispatchManager: () => DispatchManager;
  getEscortManager: () => EscortManager;
  getActorManager: () => ShipActorManager;
  getCommanderHistory: (role: "flagship" | "dock", fleetId: string) => Promise<import("./types.js").StreamMessage[]>;
  loadFleets: () => Promise<Array<{
    id: string;
    name: string;
    repos: FleetRepo[];
    skillSources?: FleetSkillSources;
    sharedRulePaths?: string[];
    shipRulePaths?: string[];
    customInstructions?: CustomInstructions;
    gates?: import("./types.js").FleetGateSettings;
    gatePrompts?: Partial<Record<import("./types.js").GateType, string>>;
    qaRequiredPaths?: string[];
    maxConcurrentSorties?: number;
  }>>;
  loadRules: (paths: string[]) => Promise<string>;
  loadAdmiralSettings: () => Promise<AdmiralSettings>;
  broadcastRequestResult: (fleetId: string, result: string) => void;
  deliverHeadsUp: (notification: HeadsUpNotification) => boolean;
  resumeAllUnits: () => Promise<ResumeAllUnitResult[]>;
  requestRestart: () => void;
}

interface ApiResponse {
  ok: boolean;
  result?: string;
  error?: string;
  phase?: string;
  transitions?: Array<Record<string, unknown>>;
  ships?: unknown[];
  results?: ResumeAllUnitResult[];
  summary?: { resumed: number; skipped: number; errors: number };
}

function validateSortieRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items) || b.items.length === 0) return "items must be a non-empty array";
  const items: Array<{ repo: string; issueNumber: number; skill?: string }> = [];
  for (const item of b.items) {
    if (typeof item !== "object" || item === null) return "Each item must be an object";
    const it = item as Record<string, unknown>;
    if (typeof it.repo !== "string" || !REPO_PATTERN.test(it.repo)) return `Invalid repo format: ${it.repo}`;
    if (typeof it.issueNumber !== "number" || !Number.isInteger(it.issueNumber) || it.issueNumber <= 0) return `Invalid issueNumber: ${it.issueNumber}`;
    const entry: { repo: string; issueNumber: number; skill?: string } = {
      repo: it.repo,
      issueNumber: it.issueNumber,
    };
    if (typeof it.skill === "string") entry.skill = it.skill;
    items.push(entry);
  }
  return { request: "sortie", items };
}

function validateShipPauseRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-pause", shipId: b.shipId };
}

function validateShipResumeRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-resume", shipId: b.shipId };
}

function validateShipAbandonRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-abandon", shipId: b.shipId };
}

function validateShipReactivateRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-reactivate", shipId: b.shipId };
}

function validateShipDeleteRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-delete", shipId: b.shipId };
}

function validatePRReviewResultRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber) || b.prNumber <= 0) return "prNumber must be a positive integer";
  if (b.verdict !== "approve" && b.verdict !== "request-changes") return 'verdict must be "approve" or "request-changes"';
  const result: FlagshipRequest = {
    request: "pr-review-result",
    shipId: b.shipId,
    prNumber: b.prNumber,
    verdict: b.verdict,
  };
  if (typeof b.comments === "string") {
    (result as Extract<FlagshipRequest, { request: "pr-review-result" }>).comments = b.comments;
  }
  return result;
}

const VALID_SEVERITIES = new Set<HeadsUpSeverity>(["info", "warning", "urgent"]);

function validateHeadsUpRequest(body: unknown): HeadsUpNotification | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (b.from !== "dock" && b.from !== "flagship") return 'from must be "dock" or "flagship"';
  if (b.to !== "dock" && b.to !== "flagship") return 'to must be "dock" or "flagship"';
  if (b.from === b.to) return "from and to must be different";
  if (typeof b.fleetId !== "string" || !b.fleetId) return "fleetId is required";
  if (typeof b.summary !== "string" || !b.summary) return "summary is required";
  if (!VALID_SEVERITIES.has(b.severity as HeadsUpSeverity)) return 'severity must be "info", "warning", or "urgent"';
  if (typeof b.needsInvestigation !== "boolean") return "needsInvestigation must be a boolean";

  const notification: HeadsUpNotification = {
    from: b.from,
    to: b.to,
    fleetId: b.fleetId,
    summary: b.summary,
    severity: b.severity as HeadsUpSeverity,
    needsInvestigation: b.needsInvestigation,
  };
  if (typeof b.shipId === "string") notification.shipId = b.shipId;
  if (typeof b.issueNumber === "number" && Number.isInteger(b.issueNumber)) notification.issueNumber = b.issueNumber;
  return notification;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function resolveFleetContext(deps: ApiDeps, fleetId?: string): Promise<{
  fleetId: string;
  fleetRepos: FleetRepo[];
  repoRemotes: string[];
  skillSources?: FleetSkillSources;
  shipExtraPrompt?: string;
  customInstructionsText?: string;
  maxConcurrentSorties?: number;
} | string> {
  const fleets = await deps.loadFleets();
  let fleet;
  if (fleetId) {
    fleet = fleets.find((f) => f.id === fleetId);
    if (!fleet) return `Fleet not found: ${fleetId}`;
  } else if (fleets.length === 1) {
    fleet = fleets[0]!;
  } else if (fleets.length === 0) {
    return "No fleets configured";
  } else {
    const fleetList = fleets.map((f) => `  - ${f.id} (${f.name})`).join("\n");
    return `Multiple fleets exist — fleetId is required. Available fleets:\n${fleetList}`;
  }
  const fleetRepos = fleet.repos;
  const repoRemotes = fleetRepos.map((r) => r.remote).filter((r): r is string => r !== undefined);
  const sharedRules = await deps.loadRules(fleet.sharedRulePaths ?? []);
  const shipRules = await deps.loadRules(fleet.shipRulePaths ?? []);

  // Merge Admiral global settings with Fleet per-fleet settings
  const admiralSettings = await deps.loadAdmiralSettings();
  const merged = mergeSettings(admiralSettings.global, {
    customInstructions: fleet.customInstructions,
    gates: fleet.gates,
    gatePrompts: fleet.gatePrompts,
    qaRequiredPaths: fleet.qaRequiredPaths,
    maxConcurrentSorties: fleet.maxConcurrentSorties,
  });

  const ci = merged.customInstructions;
  const ciParts = [ci?.shared, ci?.ship].filter(Boolean);
  const ciText = ciParts.length > 0 ? `## Custom Instructions\n\n${ciParts.join("\n\n")}` : undefined;
  const shipExtraPrompt = [sharedRules, shipRules, ciText].filter(Boolean).join("\n\n") || undefined;
  return {
    fleetId: fleet.id,
    fleetRepos,
    repoRemotes,
    skillSources: { ...fleet.skillSources, admiralSkillsDir: ADMIRAL_SKILLS_DIR },
    shipExtraPrompt,
    customInstructionsText: ciText,
    maxConcurrentSorties: merged.maxConcurrentSorties,
  };
}

// === Ship/Escort API route handler ===

async function handleShipRoute(
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

    // Extract qaRequired from plan-gate metadata (Ship determines this during planning)
    if (targetPhase === "plan-gate" && typeof metadata.qaRequired === "boolean") {
      shipManager.setQaRequired(shipId, metadata.qaRequired);
    }

    // Fallback guard: if Ship requests qa-gate with qaRequired=false,
    // check actual changed files against fleet's qaRequiredPaths.
    // If match found, force qaRequired=true before XState evaluates canSkipQA.
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
                `[api-server] qaRequiredPaths match found for Ship ${shipId.slice(0, 8)}... — overriding qaRequired to true`,
              );
              shipManager.setQaRequired(shipId, true);
            }
          } catch (err) {
            console.warn(`[api-server] Failed to check qaRequiredPaths for Ship ${shipId.slice(0, 8)}...:`, err);
            // Non-fatal: proceed with existing qaRequired value
          }
        }
      }
    }

    // Determine the XState event based on target phase
    const actorManager = deps.getActorManager();
    let xstateEvent: import("./ship-machine.js").ShipMachineEvent;
    if (isGatePhase(targetPhase as Phase)) {
      xstateEvent = { type: "GATE_ENTER" };
    } else if (targetPhase === "done") {
      xstateEvent = { type: "COMPLETE" };
    } else {
      // For non-gate, non-done transitions requested by Ship (shouldn't normally happen)
      sendJson(res, 400, { ok: false, error: `Ships can only transition to gate phases or done, not ${targetPhase}` });
      return;
    }

    // Pre-transition consistency check: reconcile XState/DB mismatch before processing (#694)
    const dbPhase = ship.phase as Phase;
    if (!actorManager.assertPhaseConsistency(shipId, dbPhase)) {
      console.warn(`[api-server] Pre-transition reconciliation for Ship ${shipId.slice(0, 8)}...`);
      actorManager.reconcilePhase(shipId, dbPhase);
    }

    // XState is the sole authority: request transition through XState first
    const result = actorManager.requestTransition(shipId, xstateEvent);
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Transition rejected by XState: current phase is ${result.currentPhase ?? "unknown"}, cannot process ${xstateEvent.type}` });
      return;
    }

    // XState approved — persist to DB (phase + snapshot in same transaction, ADR-0017)
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
      // DB failed but XState already transitioned — revert XState to prevent split-brain (#694)
      console.error(`[api-server] DB persist failed after XState transition for Ship ${shipId.slice(0, 8)}... — reverting XState`, err);
      actorManager.reconcilePhase(shipId, result.fromPhase);
      sendJson(res, 500, { ok: false, error: "Phase transition failed: DB persist error" });
      return;
    }

    shipManager.syncPhaseFromDb(shipId);

    // Handle gate-specific side effects: launch Escort on-demand for each gate
    if (isGatePhase(result.toPhase)) {
      const gatePhase = result.toPhase as GatePhase;

      // Resolve gate type from merged settings (Admiral global + Fleet per-fleet)
      const fleets = await deps.loadFleets();
      const fleet = fleets.find((f) => f.id === ship.fleetId);
      const admiralSettings = await deps.loadAdmiralSettings();
      const mergedGateSettings = mergeSettings(admiralSettings.global, {
        customInstructions: fleet?.customInstructions,
        gates: fleet?.gates,
        gatePrompts: fleet?.gatePrompts,
        qaRequiredPaths: fleet?.qaRequiredPaths,
      });
      const gateType = resolveGateType(gatePhase, mergedGateSettings.gates);

      // Gate disabled or auto-approve: skip Escort, auto-transition to next phase
      if (gateType === null || gateType === "auto-approve") {
        const reason = gateType === null ? "gate disabled" : "auto-approve";
        console.log(`[api-server] Gate ${gatePhase} skipped (${reason}) for Ship ${shipId.slice(0, 8)}...`);
        const autoResult = actorManager.requestTransition(shipId, { type: "GATE_APPROVED" });
        if (autoResult.success) {
          const autoSnapshot = actorManager.getPersistedSnapshot(shipId);
          try {
            db.persistPhaseTransition(shipId, autoResult.fromPhase, autoResult.toPhase, "engine", {
              gate_result: "approved",
              feedback: `Auto-approved: ${reason}`,
            }, autoSnapshot);
          } catch (err) {
            console.error(`[api-server] DB persist failed for auto-approve on Ship ${shipId.slice(0, 8)}...:`, err);
          }
          shipManager.syncPhaseFromDb(shipId);
        }
        sendJson(res, 200, { ok: true, phase: autoResult.success ? autoResult.toPhase : result.toPhase });
        return;
      }

      shipManager.setGateCheck(shipId, gatePhase, gateType);

      // Re-deploy skills so Escort picks up any changes made by the Ship
      // (e.g., when the Ship modified skill source files during implementation).
      try {
        const fleetCtx = await resolveFleetContext(deps, ship.fleetId);
        const skillSources = typeof fleetCtx === "string" ? undefined : fleetCtx.skillSources;
        await shipManager.redeploySkills(shipId, skillSources);
      } catch (err) {
        console.warn(`[api-server] Skill redeploy failed for Ship ${shipId.slice(0, 8)}...:`, err);
        // Non-fatal: Escort can still run with existing (possibly stale) skills
      }

      // On-demand Escort launch: start (or resume) an Escort for this gate.
      // Unlike the persistent model, Escorts exit after each gate review
      // and are resumed with --resume sessionId for the next gate.
      const escortManager = deps.getEscortManager();

      // Build Escort custom instructions and gate prompt from merged settings
      let escortExtraPrompt: string | undefined;
      let shipCustomInstructionsText: string | undefined;
      {
        const ci = mergedGateSettings.customInstructions;
        const escortCiParts = [ci?.shared, ci?.escort].filter(Boolean);
        if (escortCiParts.length > 0) {
          escortExtraPrompt = `## Custom Instructions\n\n${escortCiParts.join("\n\n")}`;
        }
        // Build Ship's CI text for restoration after Escort exits
        const shipCiParts = [ci?.shared, ci?.ship].filter(Boolean);
        if (shipCiParts.length > 0) {
          shipCustomInstructionsText = `## Custom Instructions\n\n${shipCiParts.join("\n\n")}`;
        }
      }

      // Pass merged gate prompt for this gate type to Escort via env var
      const gatePrompt = mergedGateSettings.gatePrompts?.[gateType];

      // Build extra env vars for Escort (qaRequiredPaths, qaRequired)
      const escortExtraEnv: Record<string, string> = {};
      if (mergedGateSettings.qaRequiredPaths?.length) {
        escortExtraEnv.VIBE_ADMIRAL_QA_REQUIRED_PATHS = JSON.stringify(mergedGateSettings.qaRequiredPaths);
      }
      // Pass parent Ship's qaRequired to acceptance-test-gate Escort
      const refreshedShip = db.getShipById(shipId);
      if (refreshedShip) {
        escortExtraEnv.VIBE_ADMIRAL_QA_REQUIRED = String(refreshedShip.qaRequired);
      }

      const escortId = await escortManager.launchEscort(shipId, gatePhase, gateType, escortExtraPrompt, gatePrompt, shipCustomInstructionsText, escortExtraEnv);
      if (!escortId) {
        // Escort launch failed — revert via XState ESCORT_DIED
        const prevPhase = GATE_PREV_PHASE[gatePhase];
        console.error(
          `[api-server] Escort launch failed for Ship ${shipId.slice(0, 8)}... — reverting from ${gatePhase} to ${prevPhase}`,
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
            console.error(`[api-server] DB persist failed for revert on Ship ${shipId.slice(0, 8)}...:`, revertErr);
          }
          shipManager.syncPhaseFromDb(shipId);
        }
        shipManager.clearGateCheck(shipId);
        escortManager.notifyLaunchFailure(shipId, gatePhase, "Escort launch returned null — reverting to pre-gate phase for retry");
        sendJson(res, 500, { ok: false, error: "Escort launch failed — phase reverted to allow retry" });
        return;
      }
    }

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/gate-intent — Escort declares verdict intent before actual verdict
  // This is a fallback mechanism: if the Escort dies before calling gate-verdict,
  // the Engine can use this declared intent to auto-approve instead of reverting.
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

  // POST /api/ship/:shipId/gate-verdict — Escort submits gate result
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

    const rawFeedback = body.feedback as string | Record<string, unknown> | undefined;
    const structuredFeedback = normalizeGateFeedback(rawFeedback as Parameters<typeof normalizeGateFeedback>[0]);

    // XState is the sole authority: request transition through XState first
    const actorManager = deps.getActorManager();

    // Pre-transition consistency check: reconcile XState/DB mismatch before processing (#694)
    if (!actorManager.assertPhaseConsistency(shipId, currentPhase)) {
      console.warn(`[api-server] Pre-verdict reconciliation for Ship ${shipId.slice(0, 8)}...`);
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

    // XState approved — persist to DB
    const metadata: Record<string, unknown> = verdict === "approve"
      ? { gate_result: "approved" }
      : { gate_result: "rejected", feedback: structuredFeedback ?? "" };

    const verdictSnapshot = actorManager.getPersistedSnapshot(shipId);
    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "escort", metadata, verdictSnapshot);
    } catch (err) {
      // DB failed but XState already transitioned — revert XState to prevent split-brain (#694)
      console.error(`[api-server] DB persist failed after gate verdict for Ship ${shipId.slice(0, 8)}... — reverting XState`, err);
      actorManager.reconcilePhase(shipId, result.fromPhase);
      sendJson(res, 500, { ok: false, error: "Gate verdict failed: DB persist error" });
      return;
    }

    shipManager.syncPhaseFromDb(shipId);
    shipManager.clearGateCheck(shipId);

    // Clear gate intent — verdict was successfully submitted
    const escortMgr = deps.getEscortManager();
    escortMgr.clearGateIntent(shipId);

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/nothing-to-do — Ship declares nothing to do
  if (action === "nothing-to-do") {
    const reason = (body.reason as string) ?? "No reason provided";
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    // XState is the sole authority: request transition through XState first
    const actorManager = deps.getActorManager();
    const result = actorManager.requestTransition(shipId, { type: "NOTHING_TO_DO", reason });
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Nothing-to-do rejected by XState: current phase is ${result.currentPhase ?? "unknown"}` });
      return;
    }

    // XState approved — persist to DB
    const nothingToDoSnapshot = actorManager.getPersistedSnapshot(shipId);
    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "ship", { reason, nothingToDo: true }, nothingToDoSnapshot);
    } catch (err) {
      console.error(`[api-server] DB persist failed after nothing-to-do for Ship ${shipId.slice(0, 8)}...:`, err);
    }

    shipManager.syncPhaseFromDb(shipId);
    sendJson(res, 200, { ok: true, phase: "done" });
    return;
  }

  // POST /api/ship/:shipId/abandon — Abandon a paused Ship (transition to abandoned)
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

  // POST /api/ship/:shipId/reactivate — Reactivate an abandoned Ship (transition to paused)
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

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Only handle /api/* routes
    if (!path.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const route = path.slice(5); // strip "/api/"

    try {
      // === Ship/Escort API endpoints ===
      // Pattern: /api/ship/:shipId/<action>
      const shipRouteMatch = route.match(/^ship\/([^/]+)\/(.+)$/);
      if (shipRouteMatch) {
        const [, shipId, action] = shipRouteMatch;
        await handleShipRoute(deps, req, res, shipId!, action!);
        return;
      }

      // === Dispatch API endpoints ===

      // POST /api/dispatch — Launch a new Dispatch process
      if (route === "dispatch" && req.method === "POST") {
        const rawBody = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        const prompt = body.prompt as string | undefined;
        if (!prompt) {
          sendJson(res, 400, { ok: false, error: "prompt is required" });
          return;
        }
        const name = (body.name as string) ?? "dispatch";
        const type = (body.type as DispatchType) ?? "investigate";
        if (type !== "investigate" && type !== "modify") {
          sendJson(res, 400, { ok: false, error: 'type must be "investigate" or "modify"' });
          return;
        }
        const parentRole = (body.parentRole as CommanderRole) ?? "flagship";
        if (parentRole !== "dock" && parentRole !== "flagship") {
          sendJson(res, 400, { ok: false, error: 'parentRole must be "dock" or "flagship"' });
          return;
        }
        const fleetId = body.fleetId as string | undefined;
        if (!fleetId) {
          sendJson(res, 400, { ok: false, error: "fleetId is required" });
          return;
        }
        const cwd = body.cwd as string | undefined;
        if (!cwd) {
          sendJson(res, 400, { ok: false, error: "cwd is required" });
          return;
        }

        const dispatchManager = deps.getDispatchManager();
        const dispatch = dispatchManager.launch({
          fleetId,
          parentRole,
          prompt,
          name,
          type,
          cwd,
        });

        sendJson(res, 200, { ok: true, result: dispatch.id, dispatch: dispatchManager.toDispatch(dispatch) } as ApiResponse & { dispatch: unknown });
        return;
      }

      // GET /api/dispatches — List dispatches for a fleet
      if (route === "dispatches" && req.method === "GET") {
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        if (!fleetId) {
          sendJson(res, 400, { ok: false, error: "fleetId query parameter is required" });
          return;
        }
        const dispatchManager = deps.getDispatchManager();
        const dispatches = dispatchManager.getDispatchesByFleet(fleetId).map((d) => dispatchManager.toDispatch(d));
        sendJson(res, 200, { ok: true, dispatches } as ApiResponse & { dispatches: unknown[] });
        return;
      }

      // === Commander Notification API ===

      // POST /api/commander-notify — Commander-to-Commander heads-up notification
      if (route === "commander-notify" && req.method === "POST") {
        const rawBody = await readBody(req);
        let body: unknown;
        try {
          body = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        const notification = validateHeadsUpRequest(body);
        if (typeof notification === "string") {
          sendJson(res, 400, { ok: false, error: notification });
          return;
        }

        const delivered = deps.deliverHeadsUp(notification);
        if (!delivered) {
          sendJson(res, 503, { ok: false, error: `Target commander (${notification.to}) is not running for fleet ${notification.fleetId}` });
          return;
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      // === Frontend API endpoints ===

      // GET /api/ships — Ship list as JSON array (for Frontend)
      // Escorts are in a separate table; attach escort info to parent ships.
      if (route === "ships" && req.method === "GET") {
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        const shipManager = deps.getShipManager();
        const escortManager = deps.getEscortManager();
        const ships = fleetId
          ? shipManager.getShipsByFleet(fleetId)
          : shipManager.getAllShips();

        // Attach escort info from escorts table
        const enriched = ships.map((s) => {
          const isRunning = escortManager.isEscortRunning(s.id);
          if (!isRunning) return s;
          return {
            ...s,
            escorts: [{ id: "escort", phase: "reviewing" as const, processDead: false }],
          };
        });

        sendJson(res, 200, { ok: true, ships: enriched });
        return;
      }

      // GET /api/ships/:id — Individual Ship data (for Frontend notification→fetch pattern)
      const shipByIdMatch = route.match(/^ships\/([^/]+)$/);
      if (shipByIdMatch && req.method === "GET") {
        const shipId = shipByIdMatch[1]!;
        const shipManager = deps.getShipManager();
        const ship = shipManager.getShip(shipId);
        if (!ship) {
          sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
          return;
        }
        sendJson(res, 200, { ok: true, ships: [ship] });
        return;
      }

      // GET /api/commander-logs — Commander chat history (for Dock↔Flagship cross-read)
      if (route === "commander-logs" && req.method === "GET") {
        const role = url.searchParams.get("role");
        if (role !== "flagship" && role !== "dock") {
          sendJson(res, 400, { ok: false, error: 'role query parameter is required and must be "flagship" or "dock"' });
          return;
        }
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        const fleets = await deps.loadFleets();
        let resolvedFleetId: string;
        if (fleetId) {
          if (!fleets.find((f) => f.id === fleetId)) {
            sendJson(res, 400, { ok: false, error: `Fleet not found: ${fleetId}` });
            return;
          }
          resolvedFleetId = fleetId;
        } else if (fleets.length === 1) {
          resolvedFleetId = fleets[0]!.id;
        } else if (fleets.length === 0) {
          sendJson(res, 400, { ok: false, error: "No fleets configured" });
          return;
        } else {
          sendJson(res, 400, { ok: false, error: "Multiple fleets exist — fleetId is required" });
          return;
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
        const logs = await deps.getCommanderHistory(role, resolvedFleetId);
        const trimmed = logs.slice(-limit);
        sendJson(res, 200, { ok: true, logs: trimmed, role, fleetId: resolvedFleetId } as ApiResponse & { logs: unknown[]; role: string; fleetId: string });
        return;
      }

      // === Flagship API endpoints (legacy routes) ===

      // GET /api/ship-status
      if (route === "ship-status" && req.method === "GET") {
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        const ctx = await resolveFleetContext(deps, fleetId);
        if (typeof ctx === "string") {
          sendJson(res, 400, { ok: false, error: ctx });
          return;
        }
        const result = await deps.requestHandler.handle(
          ctx.fleetId,
          { request: "ship-status" },
          ctx.fleetRepos,
          ctx.repoRemotes,
        );
        deps.broadcastRequestResult(ctx.fleetId, result);
        sendJson(res, 200, { ok: true, result });
        return;
      }

      // POST /api/restart — Restart Engine + Frontend
      if (route === "restart" && req.method === "POST") {
        sendJson(res, 200, { ok: true, result: "Restart initiated" });
        // Trigger restart asynchronously after response is sent
        setImmediate(() => deps.requestRestart());
        return;
      }

      // POST /api/resume-all — Resume all paused/dead Units across all Fleets (abandoned ships are skipped)
      if (route === "resume-all" && req.method === "POST") {
        const results = await deps.resumeAllUnits();
        const resumed = results.filter(r => r.status === "resumed");
        const skipped = results.filter(r => r.status === "skipped");
        const errors = results.filter(r => r.status === "error");
        sendJson(res, 200, { ok: true, results, summary: { resumed: resumed.length, skipped: skipped.length, errors: errors.length } });
        return;
      }

      // Check if route is a known POST endpoint
      const postRoutes = new Set(["sortie", "ship-pause", "ship-resume", "ship-abandon", "ship-reactivate", "ship-delete", "pr-review-result"]);
      if (!postRoutes.has(route)) {
        sendJson(res, 404, { ok: false, error: `Unknown endpoint: /api/${route}` });
        return;
      }

      // POST endpoints only
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const rawBody = await readBody(req);
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const bodyObj = body as Record<string, unknown>;
      const fleetId = (bodyObj.fleetId as string | undefined) ?? undefined;
      const ctx = await resolveFleetContext(deps, fleetId);
      if (typeof ctx === "string") {
        sendJson(res, 400, { ok: false, error: ctx });
        return;
      }

      let request: FlagshipRequest | string;

      switch (route) {
        case "sortie":
          request = validateSortieRequest(body);
          break;
        case "ship-pause":
          request = validateShipPauseRequest(body);
          break;
        case "ship-resume":
          request = validateShipResumeRequest(body);
          break;
        case "ship-abandon":
          request = validateShipAbandonRequest(body);
          break;
        case "ship-reactivate":
          request = validateShipReactivateRequest(body);
          break;
        case "ship-delete":
          request = validateShipDeleteRequest(body);
          break;
        case "pr-review-result":
          request = validatePRReviewResultRequest(body);
          break;
        default:
          sendJson(res, 404, { ok: false, error: `Unknown endpoint: /api/${route}` });
          return;
      }

      if (typeof request === "string") {
        sendJson(res, 400, { ok: false, error: request });
        return;
      }

      const result = await deps.requestHandler.handle(
        ctx.fleetId,
        request,
        ctx.fleetRepos,
        ctx.repoRemotes,
        ctx.skillSources,
        ctx.shipExtraPrompt,
        ctx.maxConcurrentSorties,
        ctx.customInstructionsText,
      );

      deps.broadcastRequestResult(ctx.fleetId, result);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api-server] Error handling ${path}:`, message);
      sendJson(res, 500, { ok: false, error: message });
    }
  };
}
