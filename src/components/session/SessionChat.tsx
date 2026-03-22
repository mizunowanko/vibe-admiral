import { memo, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from "react";
import { useSessionMessages } from "@/hooks/useSessionMessages";
import { useUIStore } from "@/stores/uiStore";
import { useShip } from "@/hooks/useShip";
import { SessionInput } from "./SessionInput";
import { SessionMessage } from "./SessionMessage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ArrowDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreamMessage } from "@/types";
import { groupToolMessages, isToolGroup } from "@/lib/group-tool-messages";
import { ToolUseGroup } from "@/components/chat/ToolUseGroup";
import { Badge } from "@/components/ui/badge";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";

type DisplayMessage = StreamMessage & { repeatCount?: number };

/** Collapse consecutive identical ship-status messages into one with a count. */
function collapseShipStatus(msgs: StreamMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const msg of msgs) {
    const prev = result[result.length - 1];
    if (
      msg.type === "system" &&
      msg.subtype === "ship-status" &&
      prev?.type === "system" &&
      prev?.subtype === "ship-status" &&
      msg.content === prev.content
    ) {
      prev.repeatCount = (prev.repeatCount ?? 1) + 1;
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

const LOG_TAIL_LIMIT = 200;

const SESSION_CONFIG = {
  flagship: {
    label: "Flagship",
    emptyMessage: "Flagship is ready. Send a command to manage ships.",
    inputPlaceholder: "Send a command to Flagship...",
  },
  dock: {
    label: "Dock",
    emptyMessage: "Dock is ready. Send a command to manage issues.",
    inputPlaceholder: "Send a command to Dock...",
  },
  ship: {
    label: "Ship",
    emptyMessage: "Waiting for output...",
    inputPlaceholder: "",
  },
  dispatch: {
    label: "Dispatch",
    emptyMessage: "Dispatch agent output will appear here.",
    inputPlaceholder: "",
  },
} as const;

interface SessionChatProps {
  sessionId: string | null;
}

export const SessionChat = memo(function SessionChat({ sessionId }: SessionChatProps) {
  const { messages, sendMessage, answerQuestion, pendingQuestion, isLoading, session } =
    useSessionMessages(sessionId);
  const engineConnected = useUIStore((s) => s.engineConnected);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  // For Ship sessions: get ship metadata for header
  const shipId = session?.type === "ship" ? session.shipId ?? null : null;
  const { ship } = useShip(shipId);

  const isCommander = session?.type === "dock" || session?.type === "flagship";
  const isShip = session?.type === "ship";

  // Apply tail limit for ship logs
  const visibleMessages = useMemo(() => {
    if (isShip && messages.length > LOG_TAIL_LIMIT) {
      return messages.slice(-LOG_TAIL_LIMIT);
    }
    return messages;
  }, [messages, isShip]);

  const displayItems = useMemo(
    () => groupToolMessages(isCommander ? collapseShipStatus(visibleMessages) : visibleMessages),
    [visibleMessages, isCommander],
  );

  const config = session ? SESSION_CONFIG[session.type] : SESSION_CONFIG.flagship;
  const chatContext = isShip ? "ship" as const : "command" as const;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setHasNewMessages(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    isAtBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  // Reset scroll state when session changes
  useEffect(() => {
    setHasNewMessages(false);
    isAtBottomRef.current = true;
    prevMessageCountRef.current = 0;
  }, [sessionId]);

  // Unified scroll management — runs before paint
  useLayoutEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const curCount = messages.length;
    prevMessageCountRef.current = curCount;

    const el = scrollRef.current;
    if (!el) return;

    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (curCount > prevCount) {
      setHasNewMessages(true);
    }
  }, [messages, isLoading]);

  if (!sessionId || !session) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">Select a session</p>
          <p className="text-sm mt-1">Choose Dock, Flagship, or a Ship from the panel</p>
        </div>
      </div>
    );
  }

  const baseIndex = isShip ? Math.max(0, messages.length - visibleMessages.length) : 0;

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Ship Header */}
      {isShip && ship && (
        <ShipHeader ship={ship} totalLogs={messages.length} visibleLogs={visibleMessages.length} />
      )}

      {/* Disconnected Banner */}
      {!engineConnected && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
          Engine disconnected — messages will not be delivered
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        <ScrollArea ref={scrollRef} className="h-full p-4" onScroll={handleScroll}>
          <div className="space-y-3">
            {visibleMessages.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">
                {config.emptyMessage}
              </p>
            )}
            {displayItems.map((item, i) =>
              isToolGroup(item) ? (
                <ToolUseGroup key={item.timestamp ?? baseIndex + i} group={item} context={chatContext} />
              ) : (
                <SessionMessage
                  key={item.timestamp ?? baseIndex + i}
                  message={item}
                  repeatCount={item.repeatCount}
                  context={chatContext}
                />
              ),
            )}
            {isLoading && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="text-xs">{config.label} is thinking...</span>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* New messages indicator */}
        {hasNewMessages && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              "absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5",
              "rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground",
              "shadow-lg transition-opacity hover:opacity-90",
            )}
          >
            <ArrowDown className="h-3 w-3" />
            New messages
          </button>
        )}
      </div>

      {/* Pending Question Banner */}
      {pendingQuestion && (
        <div className="flex items-start gap-2 border-t border-blue-500/20 bg-blue-500/5 px-4 py-2.5">
          <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-blue-500">{config.label} is asking:</p>
            <p className="mt-0.5 text-sm text-foreground">{pendingQuestion}</p>
          </div>
        </div>
      )}

      {/* Input — only for sessions with input */}
      {session.hasInput && sendMessage && (
        <SessionInput
          onSend={pendingQuestion && answerQuestion ? answerQuestion : sendMessage}
          disabled={!engineConnected}
          sessionId={session.id}
          placeholder={
            !engineConnected
              ? "Engine disconnected"
              : pendingQuestion
                ? "Type your answer..."
                : config.inputPlaceholder
          }
        />
      )}
    </div>
  );
});

/** Ship session header with phase badge and metadata */
function ShipHeader({
  ship,
  totalLogs,
  visibleLogs,
}: {
  ship: import("@/types").Ship;
  totalLogs: number;
  visibleLogs: number;
}) {
  const statusConfig = ship.processDead
    ? PROCESS_DEAD_CONFIG
    : STATUS_CONFIG[ship.phase];

  return (
    <>
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-xs text-muted-foreground">
            #{ship.issueNumber}
          </span>
          <Badge className={cn("text-[10px] px-1.5 py-0", statusConfig.color)}>
            {statusConfig.animate && (
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
            )}
            {statusConfig.label}
          </Badge>
          {ship.isCompacting && (
            <Badge className="text-[10px] px-1.5 py-0 bg-purple-500/20 text-purple-400">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Compact
            </Badge>
          )}
          {ship.gateCheck?.status === "pending" && (
            <Badge className="text-[10px] px-1.5 py-0 bg-sky-500/20 text-sky-400">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Gate
            </Badge>
          )}
        </div>
        <p className="text-xs font-medium truncate">
          {ship.issueTitle || `Issue #${ship.issueNumber}`}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground mt-1">
          <span>{ship.repo}</span>
          {ship.prUrl && (
            <a
              href={ship.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              PR: {ship.prUrl.split("/").pop()}
            </a>
          )}
          {totalLogs > visibleLogs && (
            <span className="text-muted-foreground/50">
              Showing last {visibleLogs} of {totalLogs}
            </span>
          )}
        </div>
      </div>

      {/* Gate Check Banner */}
      {ship.gateCheck && (
        <div className="px-3 py-2 border-b border-border shrink-0">
          <div
            className={cn(
              "rounded-md border p-2 text-xs",
              ship.gateCheck.status === "pending"
                ? "border-sky-500/50 bg-sky-500/10"
                : ship.gateCheck.status === "rejected"
                  ? "border-red-500/50 bg-red-500/10"
                  : "border-green-500/50 bg-green-500/10",
            )}
          >
            <div className="flex items-center justify-between">
              <span
                className={cn(
                  "font-medium",
                  ship.gateCheck.status === "pending"
                    ? "text-sky-400"
                    : ship.gateCheck.status === "rejected"
                      ? "text-red-400"
                      : "text-green-400",
                )}
              >
                Gate: {ship.gateCheck.gatePhase}
              </span>
              <span className="text-muted-foreground">
                {ship.gateCheck.gateType} | {ship.gateCheck.status}
              </span>
            </div>
            {ship.gateCheck.feedback && (
              <p className="text-muted-foreground mt-1">
                {ship.gateCheck.feedback}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
