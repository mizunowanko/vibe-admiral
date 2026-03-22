import { memo } from "react";
import type { StreamMessage } from "@/types";
import { cn } from "@/lib/utils";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { SystemMessageCard } from "./SystemMessageCard";

interface BridgeMessageProps {
  message: StreamMessage;
  repeatCount?: number;
}

export const BridgeMessage = memo(function BridgeMessage({ message, repeatCount }: BridgeMessageProps) {
  const isSystem = message.type === "system";

  // System messages with structured metadata — render as compact 1-line card
  if (
    isSystem &&
    message.meta &&
    (message.subtype === "gate-check-request" ||
      message.subtype === "pr-review-request" ||
      message.subtype === "lookout-alert")
  ) {
    return (
      <SystemMessageCard subtype={message.subtype} meta={message.meta} />
    );
  }

  // Commander status (CLI lifecycle) — Flagship/Dock
  if (isSystem && message.subtype === "commander-status") {
    const content = message.content ?? "";
    const isErrorStatus = content.includes("Failed");
    const isConnected = content.includes("connected");
    return (
      <div className="flex w-full justify-center">
        <div
          className={cn(
            "rounded px-3 py-1 text-xs font-mono",
            isErrorStatus
              ? "text-red-400/80 bg-red-500/10"
              : isConnected
                ? "text-emerald-400/80 bg-emerald-500/10"
                : "text-muted-foreground bg-muted/30",
          )}
        >
          {content}
        </div>
      </div>
    );
  }

  // AskUserQuestion — Bridge-only highlighted question banner
  if (message.type === "question") {
    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[90%] rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm">
          <span className="text-xs font-semibold text-blue-400 block mb-1">
            Bridge Question
          </span>
          <p className="whitespace-pre-wrap break-words text-blue-200/80">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  // Delegate to shared ChatMessage for all other types
  return <ChatMessage message={message} repeatCount={repeatCount} />;
});
