import { useRef, useEffect } from "react";
import { useShip } from "@/hooks/useShip";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { AcceptanceTestBanner } from "./AcceptanceTestBanner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

interface ShipDetailProps {
  shipId: string;
  onClose: () => void;
}

export function ShipDetail({ shipId, onClose }: ShipDetailProps) {
  const { ship, logs } = useShip(shipId);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (!ship) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Ship not found
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col border-l border-border">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="text-sm font-mono text-muted-foreground shrink-0">
            #{ship.issueNumber}
          </span>
          <span className="text-sm font-medium break-all">
            {ship.issueTitle || `Issue #${ship.issueNumber}`}
          </span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {ship.status}
          </Badge>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Acceptance Test Banner */}
      {ship.status === "acceptance-test" && (
        <div className="p-3">
          <AcceptanceTestBanner ship={ship} />
        </div>
      )}

      {/* Logs */}
      <ScrollArea ref={scrollRef} className="flex-1 p-4">
        <div className="space-y-1 font-mono text-xs">
          {logs.map((log, i) => (
            <div
              key={i}
              className={
                log.type === "error"
                  ? "text-red-400"
                  : log.type === "user"
                    ? "text-blue-400"
                    : "text-muted-foreground"
              }
            >
              {log.tool && (
                <span className="text-primary/60">[{log.tool}] </span>
              )}
              {log.content ?? JSON.stringify(log)}
            </div>
          ))}
          {logs.length === 0 && (
            <p className="text-center text-muted-foreground py-4">
              Waiting for output...
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
