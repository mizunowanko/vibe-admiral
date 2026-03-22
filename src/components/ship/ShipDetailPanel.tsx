import { useRef, useEffect, useMemo, useCallback } from "react";
import { useShip } from "@/hooks/useShip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ToolUseGroup } from "@/components/chat/ToolUseGroup";
import { groupToolMessages, isToolGroup } from "@/lib/group-tool-messages";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { cn } from "@/lib/utils";

const LOG_TAIL_LIMIT = 200;

interface ShipDetailPanelProps {
  shipId: string;
}

export function ShipDetailPanel({ shipId }: ShipDetailPanelProps) {
  const { ship, logs } = useShip(shipId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const tailLogs = useMemo(() => logs.slice(-LOG_TAIL_LIMIT), [logs]);

  const displayItems = useMemo(
    () => groupToolMessages(tailLogs),
    [tailLogs],
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

  const statusConfig = ship.processDead
    ? PROCESS_DEAD_CONFIG
    : STATUS_CONFIG[ship.phase];

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0">
      {/* Header */}
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

      {/* Logs */}
      <ScrollArea
        ref={scrollRef}
        className="flex-1 min-h-0 px-3 py-2"
        onScroll={handleScroll}
      >
        <div className="space-y-1">
          {logs.length > LOG_TAIL_LIMIT && (
            <p className="text-center text-muted-foreground/50 text-[10px] py-1">
              Showing last {LOG_TAIL_LIMIT} of {logs.length} entries
            </p>
          )}
          {displayItems.map((item, i) =>
            isToolGroup(item) ? (
              <ToolUseGroup
                key={item.timestamp ?? baseIndex + i}
                group={item}
                context="ship"
              />
            ) : (
              <ChatMessage
                key={item.timestamp ?? baseIndex + i}
                message={item}
                context="ship"
              />
            ),
          )}
          {tailLogs.length === 0 && (
            <p className="text-center text-muted-foreground py-8 text-xs">
              Waiting for output...
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
