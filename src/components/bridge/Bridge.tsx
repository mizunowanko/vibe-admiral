import { memo, useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from "react";
import { useCommander } from "@/hooks/useCommander";
import { useUIStore } from "@/stores/uiStore";
import { BridgeMessage } from "./BridgeMessage";
import { BridgeInput } from "./BridgeInput";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, ArrowDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreamMessage, CommanderRole } from "@/types";
import { groupToolMessages, isToolGroup } from "@/lib/group-tool-messages";
import { ToolUseGroup } from "@/components/chat/ToolUseGroup";

interface CommanderChatProps {
  fleetId: string | null;
  role: CommanderRole;
}

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

const ROLE_CONFIG = {
  flagship: {
    label: "Flagship",
    description: "Ship management — sortie, monitor, stop, resume",
    emptyMessage: "Flagship is ready. Send a command to manage ships.",
    inputPlaceholder: "Send a command to Flagship...",
  },
  dock: {
    label: "Dock",
    description: "Issue management — triage, clarity, priority",
    emptyMessage: "Dock is ready. Send a command to manage issues.",
    inputPlaceholder: "Send a command to Dock...",
  },
} as const;

export const Bridge = memo(function Bridge({ fleetId, role }: CommanderChatProps) {
  const { messages, sendMessage, answerQuestion, pendingQuestion, isLoading } = useCommander(fleetId, role);
  const engineConnected = useUIStore((s) => s.engineConnected);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const displayItems = useMemo(
    () => groupToolMessages(collapseShipStatus(messages)),
    [messages],
  );
  const config = ROLE_CONFIG[role];

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

  // Reset scroll state when fleet or role changes
  useEffect(() => {
    setHasNewMessages(false);
    isAtBottomRef.current = true;
    prevMessageCountRef.current = 0;
  }, [fleetId, role]);

  // Unified scroll management — runs before paint so scroll position is
  // preserved across DOM updates without visible flicker.
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

  if (!fleetId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a fleet to open {config.label}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
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
            {messages.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">
                {config.emptyMessage}
              </p>
            )}
            {displayItems.map((item, i) =>
              isToolGroup(item) ? (
                <ToolUseGroup key={item.timestamp ?? i} group={item} />
              ) : (
                <BridgeMessage key={item.timestamp ?? i} message={item} repeatCount={item.repeatCount} />
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

      {/* Input */}
      <BridgeInput
        onSend={pendingQuestion ? answerQuestion : sendMessage}
        disabled={!engineConnected}
        placeholder={
          !engineConnected
            ? "Engine disconnected"
            : pendingQuestion
              ? "Type your answer..."
              : config.inputPlaceholder
        }
      />
    </div>
  );
});
