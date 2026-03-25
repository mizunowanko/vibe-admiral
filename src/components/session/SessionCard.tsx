import { memo } from "react";
import type { Session, Ship } from "@/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG, phaseDisplayName } from "@/lib/ship-status";
import { Flag, Anchor } from "lucide-react";

interface SessionCardProps {
  session: Session;
  ship?: Ship | null;
  isFocused: boolean;
  onFocus: () => void;
}

export const SessionCard = memo(function SessionCard({
  session,
  ship,
  isFocused,
  onFocus,
}: SessionCardProps) {
  if (session.type === "dock" || session.type === "flagship") {
    return (
      <CommanderCard
        session={session}
        isFocused={isFocused}
        onFocus={onFocus}
      />
    );
  }

  if (session.type === "ship" && ship) {
    return (
      <ShipSessionCard
        ship={ship}
        isFocused={isFocused}
        onFocus={onFocus}
      />
    );
  }

  return null;
});

function CommanderCard({
  session,
  isFocused,
  onFocus,
}: {
  session: Session;
  isFocused: boolean;
  onFocus: () => void;
}) {
  const Icon = session.type === "flagship" ? Flag : Anchor;
  const description =
    session.type === "flagship"
      ? "Ship management — sortie, monitor, stop, resume"
      : "Issue management — triage, clarity, priority";

  return (
    <button
      onClick={onFocus}
      className={cn(
        "w-full rounded-md border px-3 py-2 text-left text-xs transition-colors",
        isFocused
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-card hover:border-primary/50 text-muted-foreground hover:text-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{session.label}</span>
        {isFocused && (
          <Badge className="ml-auto text-[10px] px-1 py-0 bg-primary/20 text-primary">
            Active
          </Badge>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">{description}</p>
    </button>
  );
}

function ShipSessionCard({
  ship,
  isFocused,
  onFocus,
}: {
  ship: Ship;
  isFocused: boolean;
  onFocus: () => void;
}) {
  const config = ship.processDead
    ? PROCESS_DEAD_CONFIG
    : STATUS_CONFIG[ship.phase];

  return (
    <div
      onClick={onFocus}
      className={cn(
        "cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-xs transition-colors hover:border-primary/50",
        isFocused && "border-primary bg-primary/10",
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-muted-foreground">
            #{ship.issueNumber}
          </span>
          <Badge className={cn("text-[10px] px-1 py-0", config.color)}>
            {config.animate && (
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
            )}
            {ship.processDead ? "Error" : phaseDisplayName(ship.phase)}
          </Badge>
          {ship.isCompacting && (
            <Badge className="text-[10px] px-1 py-0 bg-purple-500/20 text-purple-400">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Compact
            </Badge>
          )}
          {ship.gateCheck?.status === "pending" && (
            <Badge className="text-[10px] px-1 py-0 bg-sky-500/20 text-sky-400">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Gate
            </Badge>
          )}
          {ship.escorts && ship.escorts.length > 0 && (
            <Badge className="text-[10px] px-1 py-0 bg-amber-500/20 text-amber-400">
              <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
              Escort
            </Badge>
          )}
        </div>
      </div>
      <p className="truncate text-foreground">
        {ship.issueTitle || `Issue #${ship.issueNumber}`}
      </p>
      <p className="truncate text-muted-foreground mt-0.5">
        {ship.repo}
      </p>
    </div>
  );
}
