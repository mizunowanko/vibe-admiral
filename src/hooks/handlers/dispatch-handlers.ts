import type { MessageHandler } from "./handler-types";
import { createDispatchSession } from "@/stores/sessionStore";

export const handleDispatchCreated: MessageHandler<"dispatch:created"> = (msg, ctx) => {
  const { dispatch, fleetId } = msg.data;
  ctx.sessionStore.upsertDispatch(dispatch);
  ctx.sessionStore.registerSession(
    createDispatchSession(
      dispatch.id,
      fleetId,
      dispatch.name,
      dispatch.parentRole,
      dispatch.parentSessionId,
    ),
  );
};

export const handleDispatchStream: MessageHandler<"dispatch:stream"> = (msg, ctx) => {
  const existingSession = ctx.sessionStore.getState().sessions.get(`dispatch-${msg.data.id}`);
  if (!existingSession) {
    const dispatch = ctx.sessionStore.getState().dispatches.get(msg.data.id);
    const dispatchName = dispatch?.name ?? "Dispatch";
    ctx.sessionStore.registerSession(
      createDispatchSession(
        msg.data.id,
        msg.data.fleetId,
        dispatchName,
        msg.data.parentRole,
      ),
    );
  }
  ctx.sessionStore.addDispatchLog(msg.data.id, msg.data.message);
};

export const handleDispatchCompleted: MessageHandler<"dispatch:completed"> = (msg, ctx) => {
  ctx.sessionStore.upsertDispatch(msg.data.dispatch);
};
