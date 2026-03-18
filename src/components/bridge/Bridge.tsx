import { memo, useRef, useEffect, useMemo, useState, useCallback } from "react";
import { useBridge } from "@/hooks/useBridge";
import { useUIStore } from "@/stores/uiStore";
import { BridgeMessage } from "./BridgeMessage";
import { BridgeInput } from "./BridgeInput";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquare, Loader2, ArrowDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreamMessage } from "@/types";

interface BridgeProps {
  fleetId: string | null;
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

export const Bridge = memo(function Bridge({ fleetId }: BridgeProps) {
  const { messages, sendMessage, answerQuestion, pendingQuestion, isLoading } = useBridge(fleetId);
  const engineConnected = useUIStore((s) => s.engineConnected);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const displayMessages = useMemo(() => collapseShipStatus(messages), [messages]);

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

  // Reset scroll state when fleet changes
  useEffect(() => {
    setHasNewMessages(false);
    isAtBottomRef.current = true;
    prevMessageCountRef.current = 0;
  }, [fleetId]);

  useEffect(() => {
    const grew = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (isAtBottomRef.current) {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    } else if (grew) {
      setHasNewMessages(true);
    }
  }, [messages, isLoading]);

  if (!fleetId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a fleet to open the Bridge
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageSquare className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Bridge</h2>
        <span className="text-xs text-muted-foreground">
          Central command for issue management and ship coordination
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div
            className={cn(
              "h-2 w-2 rounded-full",
              engineConnected ? "bg-green-500" : "bg-red-500",
            )}
          />
          <span className="text-xs text-muted-foreground">
            {engineConnected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

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
                Bridge is ready. Send a command to manage issues and coordinate ships.
              </p>
            )}
            {displayMessages.map((msg, i) => (
              <BridgeMessage key={i} message={msg} repeatCount={msg.repeatCount} />
            ))}
            {isLoading && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="text-xs">Bridge is thinking...</span>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* New messages indicator */}
        {hasNewMessages && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
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
            <p className="text-xs font-medium text-blue-500">Bridge is asking:</p>
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
              : "Send a command to the Bridge..."
        }
      />
    </div>
  );
});
