import type { StreamMessage } from "@/types";
import { cn } from "@/lib/utils";

interface BridgeMessageProps {
  message: StreamMessage;
}

const STATUS_COLORS: Record<string, string> = {
  sortie: "text-yellow-400",
  investigating: "text-blue-400",
  planning: "text-indigo-400",
  implementing: "text-violet-400",
  testing: "text-cyan-400",
  reviewing: "text-orange-400",
  "acceptance-test": "text-amber-400",
  merging: "text-emerald-400",
  done: "text-green-400",
  error: "text-red-400",
};

function getStatusColor(content: string): string {
  for (const [status, color] of Object.entries(STATUS_COLORS)) {
    if (content.includes(`: ${status}`)) return color;
  }
  return "text-muted-foreground";
}

export function BridgeMessage({ message }: BridgeMessageProps) {
  const isUser = message.type === "user";
  const isError = message.type === "error";
  const isSystem = message.type === "system";

  // Ship status inline badge
  if (isSystem && message.subtype === "ship-status") {
    return (
      <div className="flex w-full justify-start">
        <div
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono",
            "bg-muted/50 border border-border/50",
          )}
        >
          <span className="text-muted-foreground">⚓</span>
          <span className={getStatusColor(message.content ?? "")}>
            {message.content}
          </span>
        </div>
      </div>
    );
  }

  // Action result
  if (isSystem && message.subtype === "action-result") {
    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[90%] rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-xs font-mono text-primary/70 block mb-1">
            [Engine]
          </span>
          <pre className="whitespace-pre-wrap break-words text-card-foreground font-mono text-xs">
            {message.content}
          </pre>
        </div>
      </div>
    );
  }

  // Bridge status (CLI lifecycle)
  if (isSystem && message.subtype === "bridge-status") {
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

  // Acceptance test banner
  if (isSystem && message.subtype === "acceptance-test") {
    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[90%] rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-xs font-semibold text-amber-400 block mb-1">
            Acceptance Test Required
          </span>
          <p className="whitespace-pre-wrap break-words text-amber-200/80 text-xs">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

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
