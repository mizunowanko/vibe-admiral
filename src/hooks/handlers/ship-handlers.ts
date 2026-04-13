import type { MessageHandler } from "./handler-types";
import type { Ship } from "@/types";

export const historyRequestedAt = new Map<string, number>();

export const handleShipData: MessageHandler<"ship:data"> = (msg, ctx) => {
  const shipList = msg.data as Ship[];
  for (const ship of shipList) {
    ctx.shipStore.upsertShip(ship);
    if (ship.phase !== "done") {
      historyRequestedAt.set(ship.id, Date.now());
      ctx.wsClient.send({ type: "ship:logs", data: { id: ship.id } });
    }
  }
};

export const handleShipCreated: MessageHandler<"ship:created"> = (msg, ctx) => {
  const data = msg.data;
  if ("fleetId" in data && data.fleetId) {
    ctx.shipStore.updateShipFromApi(data.id, data.fleetId);
  } else {
    ctx.shipStore.updateShipFromApi(data.id);
  }
};

export const handleShipUpdated: MessageHandler<"ship:updated"> = (msg, ctx) => {
  const data = msg.data;
  if ("fleetId" in data && data.fleetId) {
    ctx.shipStore.updateShipFromApi(data.id, data.fleetId);
  } else {
    ctx.shipStore.updateShipFromApi(data.id);
  }
};

export const handleShipCompacting: MessageHandler<"ship:compacting"> = (msg, ctx) => {
  ctx.shipStore.setShipCompacting(msg.data.id, msg.data.isCompacting);
};

export const handleShipStream: MessageHandler<"ship:stream"> = (msg, ctx) => {
  ctx.shipStore.addShipLog(msg.data.id, msg.data.message);
};

export const handleShipHistory: MessageHandler<"ship:history"> = (msg, ctx) => {
  if (msg.data.messages.length > 0) {
    const requestedAt = historyRequestedAt.get(msg.data.id) ?? 0;
    historyRequestedAt.delete(msg.data.id);
    ctx.shipStore.mergeShipHistory(msg.data.id, msg.data.messages, requestedAt);
  }
};

export const handleShipDone: MessageHandler<"ship:done"> = (msg, ctx) => {
  const data = msg.data;
  if ("fleetId" in data && data.fleetId) {
    ctx.shipStore.updateShipFromApi(data.id, data.fleetId);
  } else {
    ctx.shipStore.updateShipFromApi(data.id);
  }
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
