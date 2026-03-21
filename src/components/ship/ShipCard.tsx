import type { Ship } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { Square, RotateCcw } from "lucide-react";

interface ShipCardProps {
  ship: Ship;
  onSelect: () => void;
  onStop: () => void;
  onRetry?: () => void;
}

export function ShipCard({ ship, onSelect, onStop, onRetry }: ShipCardProps) {
  const config = ship.nothingToDo
    ? { label: "Nothing to do", color: "bg-slate-500/20 text-slate-400", textColor: "text-slate-400" }
    : ship.processDead
      ? PROCESS_DEAD_CONFIG
      : STATUS_CONFIG[ship.phase];
  const isActive = ship.phase !== "done" && ship.phase !== "stopped" && !ship.processDead;

  return (
    <div
      onClick={onSelect}
      className={cn(
        "cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-md",
        ship.gateCheck?.status === "pending" && "border-sky-500/50 ring-1 ring-sky-500/20",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-mono text-muted-foreground">
            #{ship.issueNumber}
          </span>
          <Badge className={cn("text-[10px]", config.color)}>
            {config.animate && (
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            )}
            {config.label}
          </Badge>
          {ship.isCompacting && (
            <Badge className="text-[10px] bg-purple-500/20 text-purple-400">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              Compacting
            </Badge>
          )}
          {ship.gateCheck && ship.gateCheck.status === "pending" && (
            <Badge className="text-[10px] bg-sky-500/20 text-sky-400">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              Gate
            </Badge>
          )}
        </div>
        {isActive && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            <Square className="h-3 w-3" />
          </Button>
        )}
        {ship.processDead && onRetry && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
          >
            <RotateCcw className="h-3 w-3" />
            Retry
          </Button>
        )}
      </div>

      {/* Title */}
      <p className="text-sm font-medium truncate">{ship.issueTitle || `Issue #${ship.issueNumber}`}</p>

      {/* Repo */}
      <p className="text-xs text-muted-foreground truncate mt-1">
        {ship.repo}
      </p>

      {/* Gate Check Status */}
      {ship.gateCheck && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {ship.gateCheck.gatePhase}
            </span>
            {ship.gateCheck.status === "pending" && (
              <span className="text-[10px] text-sky-400">
                Awaiting review
              </span>
            )}
            {ship.gateCheck.status === "rejected" && (
              <span className="text-[10px] text-red-400">Rejected</span>
            )}
          </div>
          {ship.gateCheck.feedback && (
            <p className="text-[10px] text-muted-foreground mt-1 truncate">
              {ship.gateCheck.feedback}
            </p>
          )}
        </div>
      )}

      {/* Nothing to do reason */}
      {ship.nothingToDo && ship.nothingToDoReason && (
        <div className="mt-2 pt-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground truncate">
            {ship.nothingToDoReason}
          </p>
        </div>
      )}

      {/* PR URL + Review Status */}
      {ship.prUrl && (
        <div className="mt-2 pt-2 border-t border-border flex items-center gap-2">
          <a
            href={ship.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            PR
          </a>
          {ship.prReviewStatus === "pending" && (
            <span className="text-[10px] text-slate-400">Bridge review pending</span>
          )}
          {ship.prReviewStatus === "approved" && (
            <span className="text-[10px] text-green-400">Approved</span>
          )}
          {ship.prReviewStatus === "changes-requested" && (
            <span className="text-[10px] text-red-400">Changes requested</span>
          )}
        </div>
      )}
    </div>
  );
}
