import type { MessageHandler } from "./handler-types";
import type { Ship } from "@/types";
import { createShipSession } from "@/stores/sessionStore";

export const handleShipData: MessageHandler<"ship:data"> = (msg, ctx) => {
  const shipList = msg.data as Ship[];
  const currentLogs = ctx.shipStore.getState().shipLogs;
  for (const ship of shipList) {
    ctx.shipStore.upsertShip(ship);
    ctx.sessionStore.registerSession(
      createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
    );
    if (ship.phase !== "done" && !currentLogs.has(ship.id)) {
      ctx.wsClient.send({ type: "ship:logs", data: { id: ship.id } });
    }
  }
};

export const handleShipCreated: MessageHandler<"ship:created"> = (msg, ctx) => {
  void ctx.shipStore.updateShipFromApi(msg.data.shipId).then(() => {
    const ship = ctx.shipStore.getState().ships.get(msg.data.shipId) as Ship | undefined;
    if (ship) {
      ctx.sessionStore.registerSession(
        createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
      );
    }
  });
};

export const handleShipUpdated: MessageHandler<"ship:updated"> = (msg, ctx) => {
  void ctx.shipStore.updateShipFromApi(msg.data.shipId).then(() => {
    const ship = ctx.shipStore.getState().ships.get(msg.data.shipId) as Ship | undefined;
    if (ship) {
      ctx.sessionStore.registerSession(
        createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
      );
    }
  });
};

export const handleShipCompacting: MessageHandler<"ship:compacting"> = (msg, ctx) => {
  ctx.shipStore.setShipCompacting(msg.data.id, msg.data.isCompacting);
};

export const handleShipStream: MessageHandler<"ship:stream"> = (msg, ctx) => {
  ctx.shipStore.addShipLog(msg.data.id, msg.data.message);
};

export const handleShipHistory: MessageHandler<"ship:history"> = (msg, ctx) => {
  if (msg.data.messages.length > 0) {
    ctx.shipStore.mergeShipHistory(msg.data.id, msg.data.messages);
  }
};

export const handleShipDone: MessageHandler<"ship:done"> = (msg, ctx) => {
  void ctx.shipStore.updateShipFromApi(msg.data.shipId);
};

export const handleShipRemoved: MessageHandler<"ship:removed"> = (msg, ctx) => {
  ctx.shipStore.removeShip(msg.data.shipId);
};

export const handleShipGatePending: MessageHandler<"ship:gate-pending"> = (msg, ctx) => {
  ctx.shipStore.setGateCheck(msg.data.id, {
    gatePhase: msg.data.gatePhase,
    gateType: msg.data.gateType,
    status: "pending",
  });
};

export const handleShipGateResolved: MessageHandler<"ship:gate-resolved"> = (msg, ctx) => {
  if (msg.data.approved) {
    ctx.shipStore.clearGateCheck(msg.data.id);
  } else {
    ctx.shipStore.setGateCheck(msg.data.id, {
      gatePhase: msg.data.gatePhase,
      gateType: msg.data.gateType,
      status: "rejected",
      feedback: msg.data.feedback,
    });
  }
};
