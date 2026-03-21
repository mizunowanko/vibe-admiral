import { useRef, useEffect, useMemo, useCallback } from "react";
import { useShip } from "@/hooks/useShip";
import { useShipStore } from "@/stores/shipStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ToolUseGroup } from "@/components/chat/ToolUseGroup";
import { groupToolMessages, isToolGroup } from "@/lib/group-tool-messages";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { cn } from "@/lib/utils";

const LOG_TAIL_LIMIT = 200;

export function ShipDetailModal() {
  const selectedShipId = useShipStore((s) => s.selectedShipId);
  const selectShip = useShipStore((s) => s.selectShip);

  return (
    <Dialog
      open={!!selectedShipId}
      onOpenChange={(open) => {
        if (!open) selectShip(null);
      }}
    >
      {selectedShipId && (
        <ShipDetailContent shipId={selectedShipId} />
      )}
    </Dialog>
  );
}

function ShipDetailContent({ shipId }: { shipId: string }) {
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
    <DialogContent className="max-w-[85vw] w-[85vw] h-[85vh] flex flex-col p-0 gap-0">
      <DialogHeader className="px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            <DialogTitle className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground">
                #{ship.issueNumber}
              </span>
              <span className="break-all">
                {ship.issueTitle || `Issue #${ship.issueNumber}`}
              </span>
            </DialogTitle>
            <Badge className={cn("text-xs px-2 py-0.5", statusConfig.color)}>
              {statusConfig.animate && (
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              {statusConfig.label}
            </Badge>
            {ship.isCompacting && (
              <Badge className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-400">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                Compacting
              </Badge>
            )}
            {ship.gateCheck?.status === "pending" && (
              <Badge className="text-xs px-2 py-0.5 bg-sky-500/20 text-sky-400">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                Gate: {ship.gateCheck.gateType}
              </Badge>
            )}
          </div>
        </div>
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground mt-1">
            <span>Branch: <code className="text-xs">{ship.branchName}</code></span>
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
            <span className="text-xs">{ship.repo}</span>
          </div>
        </DialogDescription>
      </DialogHeader>

      {/* Gate Check Banner */}
      {ship.gateCheck && (
        <div className="px-6 py-3 border-b border-border shrink-0">
          <div
            className={cn(
              "rounded-lg border p-3",
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
                  "text-sm font-medium",
                  ship.gateCheck.status === "pending"
                    ? "text-sky-400"
                    : ship.gateCheck.status === "rejected"
                      ? "text-red-400"
                      : "text-green-400",
                )}
              >
                Gate: {ship.gateCheck.gatePhase}
              </span>
              <span className="text-xs text-muted-foreground">
                {ship.gateCheck.gateType} | {ship.gateCheck.status}
              </span>
            </div>
            {ship.gateCheck.feedback && (
              <p className="text-xs text-muted-foreground mt-2">
                {ship.gateCheck.feedback}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Logs */}
      <ScrollArea
        ref={scrollRef}
        className="flex-1 min-h-0 px-6 py-4"
        onScroll={handleScroll}
      >
        <div className="space-y-1">
          {logs.length > LOG_TAIL_LIMIT && (
            <p className="text-center text-muted-foreground/50 text-xs py-1">
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
            <p className="text-center text-muted-foreground py-8 text-sm">
              Waiting for output...
            </p>
          )}
        </div>
      </ScrollArea>
    </DialogContent>
  );
}
