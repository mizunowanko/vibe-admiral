/**
 * Dispatch API routes: /api/dispatch, /api/dispatches
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps, ApiResponse } from "./api-server.js";
import { sendJson } from "./api-server.js";
import type { DispatchType, CommanderRole } from "./types.js";

/** POST /api/dispatch — Launch a new Dispatch process.
 *  Body is pre-parsed by the router (api-server.ts) for fleetId extraction. */
export async function handleDispatchCreate(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
  body: Record<string, unknown>,
): Promise<void> {
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
}

/** GET /api/dispatches — List dispatches for a fleet */
export async function handleDispatchList(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
): Promise<void> {
  const dispatchManager = deps.getDispatchManager();
  const dispatches = dispatchManager.getDispatchesByFleet(fleetId).map((d) => dispatchManager.toDispatch(d));
  sendJson(res, 200, { ok: true, dispatches } as ApiResponse & { dispatches: unknown[] });
}
