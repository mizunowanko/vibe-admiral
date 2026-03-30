import { memo, useState, useCallback } from "react";
import { Anchor, Flag, Pause, Play, XCircle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG, phaseDisplayName, gateTypeDisplayName } from "@/lib/ship-status";
import { useShipStore } from "@/stores/shipStore";
import type { Session, Ship } from "@/types";

interface SessionHeaderProps {
  session: Session;
  ship?: Ship | null;
  engineConnected: boolean;
  totalLogs?: number;
  visibleLogs?: number;
}

export const SessionHeader = memo(function SessionHeader({
  session,
  ship,
  engineConnected,
  totalLogs = 0,
  visibleLogs = 0,
}: SessionHeaderProps) {
  if (session.type === "ship" && ship) {
    return <ShipSessionHeader ship={ship} totalLogs={totalLogs} visibleLogs={visibleLogs} />;
  }

  if (session.type === "dock" || session.type === "flagship") {
    return <CommanderSessionHeader type={session.type} engineConnected={engineConnected} />;
  }

  return null;
});

/** Dock / Flagship header with icon, label, and connection indicator. */
function CommanderSessionHeader({
  type,
  engineConnected,
}: {
  type: "dock" | "flagship";
  engineConnected: boolean;
}) {
  const isDock = type === "dock";
  const Icon = isDock ? Anchor : Flag;
  const label = isDock ? "Dock" : "Flagship";

  return (
    <div className="px-3 py-2 border-b border-border shrink-0 flex items-center gap-2">
      <Icon className="h-4 w-4 text-primary" />
      <span className="text-sm font-semibold">{label}</span>
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          engineConnected ? "bg-green-500" : "bg-red-500",
        )}
        title={engineConnected ? "Connected" : "Disconnected"}
      />
    </div>
  );
}

/** Ship header with phase badge, action buttons, metadata, and gate check banner. */
function ShipSessionHeader({
  ship,
  totalLogs,
  visibleLogs,
}: {
  ship: Ship;
  totalLogs: number;
  visibleLogs: number;
}) {
  const statusConfig = ship.processDead
    ? PROCESS_DEAD_CONFIG
    : STATUS_CONFIG[ship.phase];

  return (
    <>
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-xs text-muted-foreground">
            #{ship.issueNumber}
          </span>
          <Badge className={cn("text-[10px] px-1.5 py-0", statusConfig.color)}>
            {statusConfig.animate && (
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
            )}
            {ship.processDead ? "Error" : phaseDisplayName(ship.phase)}
          </Badge>
          <ShipActions ship={ship} />
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
          {totalLogs > visibleLogs && (
            <span className="text-muted-foreground/50">
              Showing last {visibleLogs} of {totalLogs}
            </span>
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
                Gate: {phaseDisplayName(ship.gateCheck.gatePhase)}
              </span>
              <span className="text-muted-foreground">
                {gateTypeDisplayName(ship.gateCheck.gateType)} | {ship.gateCheck.status.charAt(0).toUpperCase() + ship.gateCheck.status.slice(1)}
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
    </>
  );
}

/** Action buttons for Ship lifecycle management (pause/resume/abandon/reactivate). */
function ShipActions({ ship }: { ship: Ship }) {
  const { pauseShip, retryShip, abandonShip, reactivateShip } = useShipStore();
  const [loading, setLoading] = useState(false);

  const handleAction = useCallback(async (action: () => Promise<void>) => {
    setLoading(true);
    try {
      await action();
    } finally {
      setLoading(false);
    }
  }, []);

  const isActive = ship.phase !== "done" && ship.phase !== "paused" && ship.phase !== "abandoned";

  return (
    <div className="ml-auto flex items-center gap-1">
      {/* Active ship: show pause button */}
      {isActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-gray-400"
          title="Pause"
          disabled={loading}
          onClick={(e) => { e.stopPropagation(); handleAction(() => pauseShip(ship.id)); }}
        >
          <Pause className="h-3.5 w-3.5" />
        </Button>
      )}

      {/* Paused ship: show resume and abandon buttons */}
      {ship.phase === "paused" && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-green-400"
            title="Resume"
            disabled={loading}
            onClick={(e) => { e.stopPropagation(); handleAction(() => retryShip(ship.id)); }}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-rose-400"
            title="Abandon"
            disabled={loading}
            onClick={(e) => { e.stopPropagation(); handleAction(() => abandonShip(ship.id)); }}
          >
            <XCircle className="h-3.5 w-3.5" />
          </Button>
        </>
      )}

      {/* Process-dead ship (not paused/abandoned): show resume button */}
      {ship.processDead && isActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-green-400"
          title="Resume"
          disabled={loading}
          onClick={(e) => { e.stopPropagation(); handleAction(() => retryShip(ship.id)); }}
        >
          <Play className="h-3.5 w-3.5" />
        </Button>
      )}

      {/* Abandoned ship: show reactivate button */}
      {ship.phase === "abandoned" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-amber-400"
          title="Reactivate"
          disabled={loading}
          onClick={(e) => { e.stopPropagation(); handleAction(() => reactivateShip(ship.id)); }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
