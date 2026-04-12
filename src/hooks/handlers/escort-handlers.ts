import type { MessageHandler } from "./handler-types";

export const handleEscortStream: MessageHandler<"escort:stream"> = (msg, ctx) => {
  ctx.shipStore.addEscortLog(msg.data.id, msg.data.message);
};

export const handleEscortCompleted: MessageHandler<"escort:completed"> = () => {};
