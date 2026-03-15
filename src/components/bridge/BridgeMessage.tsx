import type { StreamMessage } from "@/types";
import { cn } from "@/lib/utils";

interface BridgeMessageProps {
  message: StreamMessage;
}

export function BridgeMessage({ message }: BridgeMessageProps) {
  const isUser = message.type === "user";
  const isError = message.type === "error";

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : isError
              ? "bg-destructive/10 text-destructive-foreground border border-destructive/20"
              : "bg-card text-card-foreground",
        )}
      >
        {message.tool && (
          <span className="text-xs font-mono text-muted-foreground block mb-1">
            [{message.tool}]
          </span>
        )}
        <p className="whitespace-pre-wrap break-words">
          {message.content ?? ""}
        </p>
      </div>
    </div>
  );
}
