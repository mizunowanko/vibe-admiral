import { useRef, useEffect, useMemo, useCallback } from "react";
import { useShip } from "@/hooks/useShip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ShipLogPanelProps {
  shipId: string;
  onClose: () => void;
}

const LOG_TAIL_LIMIT = 100;

export function ShipLogPanel({ shipId, onClose }: ShipLogPanelProps) {
  const { ship, logs } = useShip(shipId);
  const scrollRef = useRef<HTMLDivElement>(null);
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
        <div className="space-y-0.5 font-mono text-xs">
          {logs.length > LOG_TAIL_LIMIT && (
            <p className="text-center text-muted-foreground/50 text-[10px] py-1">
              Showing last {LOG_TAIL_LIMIT} of {logs.length} entries
            </p>
          )}
          {tailLogs.map((log, i) => (
            <div
              key={baseIndex + i}
              className={cn(
                log.type === "error" && "text-red-400",
                log.type === "user" && "text-blue-400",
                log.type === "assistant" && "text-foreground/90",
                log.type === "system" && "text-yellow-400/80",
                log.type === "tool_use" && "text-cyan-400/80",
                log.type === "tool_result" && "text-muted-foreground",
                log.type === "result" && "text-green-400",
                !["error", "user", "assistant", "system", "tool_use", "tool_result", "result"].includes(log.type) &&
                  "text-muted-foreground",
              )}
            >
              <span className="text-muted-foreground/50 select-none">
                [{log.type}]
              </span>{" "}
              {log.tool && (
                <span className="text-primary/60">{log.tool}: </span>
              )}
              {log.content ?? JSON.stringify(log)}
            </div>
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
