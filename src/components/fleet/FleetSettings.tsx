import { useState } from "react";
import { useFleetStore } from "@/stores/fleetStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings, Plus, Trash2, X } from "lucide-react";

export function FleetSettings() {
  const selectedFleet = useFleetStore((s) => s.selectedFleet);
  const createFleet = useFleetStore((s) => s.createFleet);
  const updateFleet = useFleetStore((s) => s.updateFleet);
  const deleteFleet = useFleetStore((s) => s.deleteFleet);

  const [name, setName] = useState(selectedFleet?.name ?? "");
  const [repos, setRepos] = useState<string[]>(selectedFleet?.repos ?? []);
  const [newRepo, setNewRepo] = useState("");

  const isNew = !selectedFleet;

  const handleSave = () => {
    if (!name.trim()) return;
    if (isNew) {
      createFleet(name.trim(), repos);
    } else {
      updateFleet(selectedFleet.id, name.trim(), repos);
    }
  };

  const handleAddRepo = () => {
    const trimmed = newRepo.trim();
    if (!trimmed || repos.includes(trimmed)) return;
    setRepos([...repos, trimmed]);
    setNewRepo("");
  };

  const handleRemoveRepo = (repo: string) => {
    setRepos(repos.filter((r) => r !== repo));
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Settings className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">
          {isNew ? "Create Fleet" : "Fleet Settings"}
        </h2>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-lg space-y-6">
          {/* Name */}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Fleet Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project Fleet"
            />
          </div>

          {/* Repos */}
          <div>
            <label className="text-sm font-medium mb-2 block">
              Repositories
            </label>
            <div className="space-y-2">
              {repos.map((repo) => (
                <div
                  key={repo}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                >
                  <span className="text-sm flex-1 font-mono">{repo}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleRemoveRepo(repo)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Input
                  value={newRepo}
                  onChange={(e) => setNewRepo(e.target.value)}
                  placeholder="owner/repo"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddRepo();
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddRepo}
                  disabled={!newRepo.trim()}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4 border-t border-border">
            <Button onClick={handleSave} disabled={!name.trim()}>
              {isNew ? "Create Fleet" : "Save Changes"}
            </Button>
            {!isNew && (
              <Button
                variant="destructive"
                onClick={() => deleteFleet(selectedFleet.id)}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Delete Fleet
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
