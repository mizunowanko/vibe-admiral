import { memo, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from "react";
import { useSessionMessages } from "@/hooks/useSessionMessages";
import { useUIStore } from "@/stores/uiStore";
import { useShip } from "@/hooks/useShip";
import { SessionInput } from "./SessionInput";
import { SessionMessage } from "./SessionMessage";
import { SessionHeader } from "./SessionHeader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreamMessage } from "@/types";
import { groupToolMessages, isToolGroup } from "@/lib/group-tool-messages";
import { ToolUseGroup } from "@/components/chat/ToolUseGroup";

type DisplayMessage = StreamMessage & { repeatCount?: number };

/**
 * System subtypes that are explicitly rendered by SessionMessage or ChatMessage.
 * Any system message whose subtype is NOT in this set (and has no special
 * meta.category) will be rendered as null by ChatMessage — filter them out
 * so they don't break tool_use grouping.
 *
 * Keep in sync with:
 * - SessionMessage.tsx render-level guards & SystemMessageCard routing
 * - ChatMessage.tsx system subtype handlers
 */
const RENDERED_SYSTEM_SUBTYPES = new Set([
  "ship-status",
  "compact-status",
  "task-notification",
  "request-result",
  "gate-check-request",
  "pr-review-request",
  "lookout-alert",
  "commander-status",
  "escort-log",
]);

/**
 * Pre-filter messages that SessionMessage/ChatMessage would suppress (return null).
 * Removing them before groupToolMessages() prevents invisible messages
 * from breaking consecutive tool_use grouping.
 */
function filterSessionMessages(msgs: StreamMessage[], context: "ship" | "command"): StreamMessage[] {
  const isShip = context === "ship";
  return msgs.filter((msg) => {
    const isSystem = msg.type === "system";
    // Ship sessions never show User messages
    if (isShip && msg.type === "user") return false;
    // Lookout alerts: suppress in Ship
    if (isSystem && msg.subtype === "lookout-alert" && isShip) return false;
    // Commander status: suppress in Ship
    if (isSystem && msg.subtype === "commander-status" && isShip) return false;
    // Escort log: suppress in non-Ship
    if (isSystem && msg.subtype === "escort-log" && !isShip) return false;
    // System messages with unrecognized subtypes render as null in ChatMessage.
    // Messages with meta.category (e.g. escort-log, dispatch-log) are handled
    // separately and should pass through.
    if (isSystem && !RENDERED_SYSTEM_SUBTYPES.has(msg.subtype ?? "") && !msg.meta?.category) return false;
    // Messages with no displayable content (ChatMessage L291 guard)
    if (!msg.content && msg.type !== "system" && msg.type !== "tool_use") return false;
    return true;
  });
}

/**
 * Collapse consecutive ship-status messages into groups.
 * - Identical messages → single message with repeatCount
 * - Different ship-status messages within COLLAPSE_WINDOW_MS → grouped with count
 *   (keeps the last message visible, collapses earlier ones)
 */
const COLLAPSE_WINDOW_MS = 5000;

function collapseShipStatus(msgs: StreamMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const msg of msgs) {
    const prev = result[result.length - 1];
    const isStatus = msg.type === "system" && msg.subtype === "ship-status";
    const prevIsStatus = prev?.type === "system" && prev?.subtype === "ship-status";

    if (isStatus && prevIsStatus) {
      const timeDiff = Math.abs((msg.timestamp ?? 0) - (prev.timestamp ?? 0));
      if (msg.content === prev.content) {
        // Identical messages — always collapse
        prev.repeatCount = (prev.repeatCount ?? 1) + 1;
      } else if (timeDiff < COLLAPSE_WINDOW_MS) {
        // Different ship-status within time window — collapse into group
        prev.repeatCount = (prev.repeatCount ?? 1) + 1;
        // Update content to show latest status, keeping the count
        prev.content = msg.content;
        prev.timestamp = msg.timestamp;
        prev.meta = msg.meta;
      } else {
        result.push({ ...msg });
      }
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
  const { messages, sendMessage, isLoading, session } =
    useSessionMessages(sessionId);
  const engineConnected = useUIStore((s) => s.engineConnected);
  const rateLimitActive = useUIStore((s) => s.rateLimitActive);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  // For Ship sessions: get ship metadata for header
  const shipId = session?.type === "ship" ? session.shipId ?? null : null;
  const { ship } = useShip(shipId);

  const isFlagship = session?.type === "flagship";
  const isShip = session?.type === "ship";

  // Apply tail limit for ship logs
  const visibleMessages = useMemo(() => {
    if (isShip && messages.length > LOG_TAIL_LIMIT) {
      return messages.slice(-LOG_TAIL_LIMIT);
    }
    return messages;
  }, [messages, isShip]);

  const config = session ? SESSION_CONFIG[session.type] : SESSION_CONFIG.flagship;
  const chatContext = isShip ? "ship" as const : "command" as const;

  // Filter → collapse → group pipeline (see filterSessionMessages doc)
  const displayItems = useMemo(() => {
    const filtered = filterSessionMessages(visibleMessages, chatContext);
    const collapsed = isFlagship ? collapseShipStatus(filtered) : filtered;
    return groupToolMessages(collapsed);
  }, [visibleMessages, isFlagship, chatContext]);

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
      {/* Session Header */}
      {session && (
        <SessionHeader
          session={session}
          ship={ship}
          engineConnected={engineConnected}
          totalLogs={messages.length}
          visibleLogs={visibleMessages.length}
        />
      )}

      {/* Disconnected Banner */}
      {!engineConnected && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-xs text-destructive">
          Engine disconnected — messages will not be delivered
        </div>
      )}

      {/* Rate Limit Banner */}
      {rateLimitActive && engineConnected && (
        <div className="border-b border-yellow-500/20 bg-yellow-500/5 px-4 py-2 text-center text-xs text-yellow-600 dark:text-yellow-400">
          API rate limit detected — requests will retry automatically
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

      {/* Input — only for sessions with input */}
      {session.hasInput && sendMessage && (
        <SessionInput
          onSend={sendMessage}
          disabled={!engineConnected}
          sessionId={session.id}
          placeholder={!engineConnected ? "Engine disconnected" : config.inputPlaceholder}
        />
      )}
    </div>
  );
});

