import type { MessageHandler } from "./handler-types";
import { createDispatchSession } from "@/stores/sessionStore";

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
  // Log routing handled by useDispatchListener
};

/** Handled by useDispatchListener */
export const handleDispatchCreated: MessageHandler<"dispatch:created"> = () => {};

/** Handled by useDispatchListener */
export const handleDispatchCompleted: MessageHandler<"dispatch:completed"> = () => {};
