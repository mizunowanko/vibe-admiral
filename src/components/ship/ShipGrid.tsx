import { memo, useMemo, useState } from "react";
import { useShipsByFleet } from "@/hooks/useShip";
import { useShipStore } from "@/stores/shipStore";
import { useFleetStore } from "@/stores/fleetStore";
import { useUIStore } from "@/stores/uiStore";
import { ShipCard } from "./ShipCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ship, Rocket, ChevronDown, ChevronRight } from "lucide-react";

interface ShipGridProps {
  fleetId: string | null;
}

export const ShipGrid = memo(function ShipGrid({ fleetId }: ShipGridProps) {
  const ships = useShipsByFleet(fleetId);
  const retryShip = useShipStore((s) => s.retryShip);
  const sortie = useShipStore((s) => s.sortie);
  const fleet = useFleetStore((s) => s.selectedFleet);
  const setViewingShipId = useUIStore((s) => s.setViewingShipId);
  const setMainView = useUIStore((s) => s.setMainView);

  const [sortieRepo, setSortieRepo] = useState("");
  const [sortieIssue, setSortieIssue] = useState("");
  const [showSortieForm, setShowSortieForm] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const activeShips = useMemo(
    () => ships.filter((s) => s.phase !== "done" && s.phase !== "stopped" && !s.processDead),
    [ships],
  );
  const inactiveShips = useMemo(
    () => ships.filter((s) => s.phase === "done" || s.phase === "stopped" || s.processDead),
    [ships],
  );

  if (!fleetId) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Select a fleet to view ships
      </div>
    );
  }

  const handleSortie = () => {
    const issueNum = parseInt(sortieIssue, 10);
    if (!sortieRepo || isNaN(issueNum)) return;
    sortie(fleetId, sortieRepo, issueNum);
    setSortieRepo("");
    setSortieIssue("");
    setShowSortieForm(false);
  };

  const handleSelectShip = (shipId: string) => {
    setViewingShipId(shipId);
    setMainView("command");
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Ship className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Ships</h2>
          <span className="text-xs text-muted-foreground">
            {activeShips.length} active
          </span>
        </div>
        <Button
          variant="default"
          size="sm"
          className="gap-1"
          onClick={() => setShowSortieForm(!showSortieForm)}
        >
          <Rocket className="h-3 w-3" />
          Sortie
        </Button>
      </div>

      {/* Sortie Form */}
      {showSortieForm && (
        <div className="border-b border-border p-3 bg-card/50">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">
                Repository
              </label>
              {fleet?.repos.length ? (
                <select
                  value={sortieRepo}
                  onChange={(e) => setSortieRepo(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  <option value="">Select repo...</option>
                  {fleet.repos.map((r) => (
                    <option
                      key={r.remote ?? r.localPath}
                      value={r.remote ?? r.localPath}
                    >
                      {r.remote ?? r.localPath}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={sortieRepo}
                  onChange={(e) => setSortieRepo(e.target.value)}
                  placeholder="owner/repo"
                />
              )}
            </div>
            <div className="w-24">
              <label className="text-xs text-muted-foreground mb-1 block">
                Issue #
              </label>
              <Input
                value={sortieIssue}
                onChange={(e) => setSortieIssue(e.target.value)}
                placeholder="#"
                type="number"
              />
            </div>
            <Button onClick={handleSortie} size="sm">
              Launch
            </Button>
          </div>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-auto p-4">
        {activeShips.length === 0 && inactiveShips.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Ship className="h-12 w-12 mb-2 opacity-20" />
            <p className="text-sm">No ships deployed</p>
            <p className="text-xs mt-1">
              Click "Sortie" to deploy a ship for an issue
            </p>
          </div>
        ) : (
          <>
            {activeShips.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeShips.map((ship) => (
                  <ShipCard
                    key={ship.id}
                    ship={ship}
                    onSelect={() => handleSelectShip(ship.id)}
                  />
                ))}
              </div>
            )}
            {inactiveShips.length > 0 && (
              <div className={activeShips.length > 0 ? "mt-4" : ""}>
                <button
                  onClick={() => setShowInactive(!showInactive)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
                >
                  {showInactive ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Inactive ({inactiveShips.length})
                </button>
                {showInactive && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {inactiveShips.map((ship) => (
                      <ShipCard
                        key={ship.id}
                        ship={ship}
                        onSelect={() => handleSelectShip(ship.id)}
                        onRetry={() => retryShip(ship.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
