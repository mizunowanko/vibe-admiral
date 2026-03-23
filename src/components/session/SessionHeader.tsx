import { memo } from "react";
import { Anchor, Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
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

/** Ship header with phase badge, metadata, and gate check banner. */
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
    </>
  );
}
