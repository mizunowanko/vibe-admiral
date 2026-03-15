import { memo, useState } from "react";
import { useShipsByFleet } from "@/hooks/useShip";
import { useShipStore } from "@/stores/shipStore";
import { useFleetStore } from "@/stores/fleetStore";
import { ShipCard } from "./ShipCard";
import { ShipDetail } from "./ShipDetail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Ship, Rocket } from "lucide-react";

interface ShipGridProps {
  fleetId: string | null;
}

export const ShipGrid = memo(function ShipGrid({ fleetId }: ShipGridProps) {
  const ships = useShipsByFleet(fleetId);
  const selectedShipId = useShipStore((s) => s.selectedShipId);
  const selectShip = useShipStore((s) => s.selectShip);
  const stopShip = useShipStore((s) => s.stopShip);
  const sortie = useShipStore((s) => s.sortie);
  const fleet = useFleetStore((s) => s.selectedFleet);

  const [sortieRepo, setSortieRepo] = useState("");
  const [sortieIssue, setSortieIssue] = useState("");
  const [showSortieForm, setShowSortieForm] = useState(false);

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

  return (
    <div className="flex flex-1">
      {/* Grid Panel */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Ship className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Ships</h2>
            <span className="text-xs text-muted-foreground">
              {ships.length} active
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
                      <option key={r} value={r}>
                        {r}
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
          {ships.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Ship className="h-12 w-12 mb-2 opacity-20" />
              <p className="text-sm">No ships deployed</p>
              <p className="text-xs mt-1">
                Click "Sortie" to deploy a ship for an issue
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {ships.map((ship) => (
                <ShipCard
                  key={ship.id}
                  ship={ship}
                  onSelect={() => selectShip(ship.id)}
                  onStop={() => stopShip(ship.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedShipId && (
        <ShipDetail
          shipId={selectedShipId}
          onClose={() => selectShip(null)}
        />
      )}
    </div>
  );
});
