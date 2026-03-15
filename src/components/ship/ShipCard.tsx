import type { Ship } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, isSafeUrl } from "@/lib/utils";
import { STATUS_CONFIG } from "@/lib/ship-status";
import { Square, ExternalLink } from "lucide-react";

interface ShipCardProps {
  ship: Ship;
  onSelect: () => void;
  onStop: () => void;
}

export function ShipCard({ ship, onSelect, onStop }: ShipCardProps) {
  const config = STATUS_CONFIG[ship.status];
  const isActive = ship.status !== "done" && ship.status !== "error";

  return (
    <div
      onClick={onSelect}
      className={cn(
        "cursor-pointer rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-md",
        ship.status === "acceptance-test" && "border-amber-500/50 ring-1 ring-amber-500/20",
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
      </div>

      {/* Title */}
      <p className="text-sm font-medium truncate">{ship.issueTitle || `Issue #${ship.issueNumber}`}</p>

      {/* Repo */}
      <p className="text-xs text-muted-foreground truncate mt-1">
        {ship.repo}
      </p>

      {/* Acceptance Test URL */}
      {ship.acceptanceTest && ship.status === "acceptance-test" && (
        <div className="mt-2 pt-2 border-t border-border">
          {isSafeUrl(ship.acceptanceTest.url) ? (
            <a
              href={ship.acceptanceTest.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              {ship.acceptanceTest.url}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              {ship.acceptanceTest.url}
            </span>
          )}
        </div>
      )}

      {/* PR URL + Review Status */}
      {ship.prUrl && (ship.status === "reviewing" || ship.status === "done") && (
        <div className="mt-2 pt-2 border-t border-border flex items-center gap-2">
          <a
            href={ship.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            PR
          </a>
          {ship.prReviewStatus === "pending" && (
            <span className="text-[10px] text-orange-400">Bridge review pending</span>
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
