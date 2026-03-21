import { useRef, useEffect, useMemo, useCallback } from "react";
import { useShip } from "@/hooks/useShip";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { X } from "lucide-react";

interface ShipLogPanelProps {
  shipId: string;
  onClose: () => void;
}

const LOG_TAIL_LIMIT = 100;

export function ShipLogPanel({ shipId, onClose }: ShipLogPanelProps) {
  const { ship, logs } = useShip(shipId);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEscapeKey(onClose);
  const isAtBottomRef = useRef(true);

  const tailLogs = useMemo(
    () => logs.slice(-LOG_TAIL_LIMIT),
    [logs],
  );

  const baseIndex = logs.length - tailLogs.length;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 30;
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [tailLogs]);

  if (!ship) return null;

  return (
    <div className="flex flex-col border-t border-border bg-background/80 max-h-[50vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-muted-foreground">
            #{ship.issueNumber}
          </span>
          <span className="text-xs font-medium truncate">
            {ship.issueTitle || `Issue #${ship.issueNumber}`}
          </span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {ship.status}
          </Badge>
          {ship.isCompacting && (
            <Badge className="text-[10px] bg-purple-500/20 text-purple-400 shrink-0">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Compacting
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Logs */}
      <ScrollArea ref={scrollRef} className="flex-1 p-3 min-h-0" onScroll={handleScroll}>
        <div className="space-y-1">
          {logs.length > LOG_TAIL_LIMIT && (
            <p className="text-center text-muted-foreground/50 text-[10px] py-1">
              Showing last {LOG_TAIL_LIMIT} of {logs.length} entries
            </p>
          )}
          {tailLogs.map((log, i) => (
            <ChatMessage key={baseIndex + i} message={log} context="ship" />
          ))}
          {tailLogs.length === 0 && (
            <p className="text-center text-muted-foreground py-4">
              No logs yet — waiting for output...
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
