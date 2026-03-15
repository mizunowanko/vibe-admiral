import { useState } from "react";
import type { StreamMessage } from "@/types";
import { cn } from "@/lib/utils";

interface BridgeMessageProps {
  message: StreamMessage;
  repeatCount?: number;
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

/** Strip code fence markers (```lang / ```) while keeping inner content. */
function stripCodeFences(text: string): string {
  return text.replace(/```\w*\n?/g, "").trim();
}

function getStatusColor(content: string): string {
  for (const [status, color] of Object.entries(STATUS_COLORS)) {
    if (content.includes(`: ${status}`)) return color;
  }
  return "text-muted-foreground";
}

export function BridgeMessage({ message, repeatCount }: BridgeMessageProps) {
  const [toolExpanded, setToolExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const isUser = message.type === "user";
  const isError = message.type === "error";
  const isSystem = message.type === "system";

  // Tool use — collapsible by default
  if (message.type === "tool_use") {
    return (
      <div className="flex w-full justify-start">
        <button
          type="button"
          className={cn(
            "max-w-[90%] rounded border-l-2 border-muted-foreground/30 px-3 py-1.5 cursor-pointer select-none text-left",
            "hover:bg-muted/30 transition-colors",
          )}
          onClick={() => setToolExpanded(!toolExpanded)}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <span className="text-[10px]">{toolExpanded ? "▼" : "▶"}</span>
            <span className="text-muted-foreground/70">
              [{message.tool}]
            </span>
          </div>
          {toolExpanded && message.content && message.content !== message.tool && (
            <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground/80 mt-1.5 font-mono leading-relaxed">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

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
          {repeatCount && repeatCount > 1 && (
            <span className="text-muted-foreground/50 text-[10px]">
              x{repeatCount}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Action result — collapsible when long
  if (isSystem && message.subtype === "action-result") {
    const content = message.content ?? "";
    const lines = content.split("\n");
    const isLong = lines.length > 3;
    const displayContent = !isLong || resultExpanded
      ? content
      : lines.slice(0, 2).join("\n") + "\n…";

    return (
      <div className="flex w-full justify-start">
        <div className="max-w-[90%] rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-xs font-mono text-primary/70 block mb-1">
            [Engine]
          </span>
          <pre className="whitespace-pre-wrap break-words text-card-foreground font-mono text-xs">
            {displayContent}
          </pre>
          {isLong && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground mt-1 underline underline-offset-2"
              onClick={() => setResultExpanded(!resultExpanded)}
            >
              {resultExpanded ? "show less" : `show more (${lines.length - 2} more lines)`}
            </button>
          )}
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
          {stripCodeFences(message.content ?? "")}
        </p>
      </div>
    </div>
  );
}
