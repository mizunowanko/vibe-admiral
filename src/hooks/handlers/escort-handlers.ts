import type { MessageHandler } from "./handler-types";

export const handleEscortStream: MessageHandler<"escort:stream"> = (msg, ctx) => {
  ctx.shipStore.addShipLog(msg.data.id, msg.data.message);
};

/** Handled by useDispatchListener / session updates */
export const handleEscortCompleted: MessageHandler<"escort:completed"> = () => {};
