import { memo } from "react";
import type { StreamMessage } from "@/types";
import { cn } from "@/lib/utils";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { SystemMessageCard } from "@/components/bridge/SystemMessageCard";

interface SessionMessageProps {
  message: StreamMessage;
  repeatCount?: number;
  context?: "command" | "bridge" | "ship";
}

/**
 * Display-rule scope filter for SessionChat messages.
 *
 * | Message subtype        | Dock | Flagship   | Ship          |
 * |------------------------|------|------------|---------------|
 * | ship-status            |  -   | all Ships  | own Ship only |
 * | gate-check-request     |  -   | all Ships  | own Ship only |
 * | pr-review-request      |  -   | all Ships  | own Ship only |
 * | lookout-alert          |  -   | all Ships  | -             |
 * | commander-status       |  ✓   | ✓          | -             |
 * | escort-log             |  -   | -          | ✓             |
 * | User message           |  ✓   | ✓          | -             |
 *
 * Flagship/Ship "own Ship" filtering is handled by the data source —
 * each session only receives messages for its scope. The render-level
 * guards here enforce Dock suppression & cross-scope rules.
 */
export const SessionMessage = memo(function SessionMessage({
  message,
  repeatCount,
  context,
}: SessionMessageProps) {
  const isSystem = message.type === "system";
  const isShip = context === "ship";

  // --- Unit-type scope guards ---

  // Ship sessions never have User messages (-p mode, stdin ignored)
  if (isShip && message.type === "user") return null;

  // Ship operation messages: suppress in Dock (context="command" without ship scope)
  // Dock and Flagship both use context="command", but Dock never receives ship
  // operation messages from Engine — this guard is defensive.
  if (
    isSystem &&
    (message.subtype === "ship-status" ||
      message.subtype === "gate-check-request" ||
      message.subtype === "pr-review-request" ||
      message.subtype === "lookout-alert")
  ) {
    // Lookout alerts: Flagship only (suppress in Ship)
    if (message.subtype === "lookout-alert" && isShip) return null;
  }

  // Commander status: suppress in Ship sessions
  if (isSystem && message.subtype === "commander-status" && isShip) return null;

  // Escort log: Ship only.
  // Check meta.category (not subtype) — Escort messages are type "assistant", not "system" (#729).
  if (message.meta?.category === "escort-log" && !isShip) return null;

  // --- Render routing ---

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

  // Commander status (CLI lifecycle) — Dock/Flagship only
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

  // Rate-limit status — soft amber pill instead of scary red error (#712)
  if (isSystem && message.subtype === "rate-limit-status") {
    return (
      <div className="flex w-full justify-center">
        <div className="rounded px-3 py-1 text-xs font-mono text-amber-400/80 bg-amber-500/10">
          {message.content ?? "Rate limit — retrying..."}
        </div>
      </div>
    );
  }

  // Delegate to shared ChatMessage for all other types
  return <ChatMessage message={message} repeatCount={repeatCount} context={context} />;
});
