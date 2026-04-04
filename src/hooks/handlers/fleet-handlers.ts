import type { MessageHandler } from "./handler-types";
import type { Fleet } from "@/types";
import {
  createCommanderSession,
  commanderSessionId,
} from "@/stores/sessionStore";

export const handleFleetData: MessageHandler<"fleet:data"> = (msg, ctx) => {
  const fleets = msg.data as Fleet[];
  ctx.fleetStore.setFleets(fleets);
  const selectedId = ctx.fleetStore.getState().selectedFleetId;
  if (selectedId) {
    ctx.sessionStore.registerSession(createCommanderSession("dock", selectedId));
    ctx.sessionStore.registerSession(createCommanderSession("flagship", selectedId));
    const currentFocus = ctx.sessionStore.getState().focusedSessionId;
    if (!currentFocus) {
      ctx.sessionStore.setFocus(commanderSessionId("flagship", selectedId), "fleet-change");
    }
  }
};

export const handleFleetCreated: MessageHandler<"fleet:created"> = (msg, ctx) => {
  const created = msg.data as { id: string; fleets: Fleet[] };
  ctx.fleetStore.setFleets(created.fleets);
  ctx.fleetStore.selectFleet(created.id);
  ctx.uiStore.setMainView("command");
  ctx.sessionStore.registerSession(createCommanderSession("dock", created.id));
  ctx.sessionStore.registerSession(createCommanderSession("flagship", created.id));
  ctx.sessionStore.setFocus(commanderSessionId("flagship", created.id), "fleet-change");
};
