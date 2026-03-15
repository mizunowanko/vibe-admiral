import { useState, useEffect } from "react";
import { useFleetStore } from "@/stores/fleetStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings, Trash2, X, FolderOpen } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";
import type { FleetRepo } from "@/types";

export function FleetSettings() {
  const selectedFleet = useFleetStore((s) => s.selectedFleet);
  const createFleet = useFleetStore((s) => s.createFleet);
  const updateFleet = useFleetStore((s) => s.updateFleet);
  const deleteFleet = useFleetStore((s) => s.deleteFleet);

  const [name, setName] = useState(selectedFleet?.name ?? "");
  const [repos, setRepos] = useState<FleetRepo[]>(selectedFleet?.repos ?? []);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const isNew = !selectedFleet;

  useEffect(() => {
    setName(selectedFleet?.name ?? "");
    setRepos(selectedFleet?.repos ?? []);
    setNewRepoPath("");
  }, [selectedFleet]);

  const saveRepos = (nextRepos: FleetRepo[]) => {
    if (!isNew && name.trim()) {
      updateFleet(selectedFleet.id, name.trim(), nextRepos);
    }
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    createFleet(name.trim(), repos);
  };

  const addRepo = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed || repos.some((r) => r.localPath === trimmed)) return;
    const nextRepos = [...repos, { localPath: trimmed }];
    setRepos(nextRepos);
    setNewRepoPath("");
    saveRepos(nextRepos);
  };

  const handleRemoveRepo = (localPath: string) => {
    const nextRepos = repos.filter((r) => r.localPath !== localPath);
    setRepos(nextRepos);
    saveRepos(nextRepos);
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
              onBlur={() => {
                if (!isNew && name.trim() && name.trim() !== selectedFleet.name) {
                  updateFleet(selectedFleet.id, name.trim(), repos);
                }
              }}
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
                  key={repo.localPath}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono block truncate">
                      {repo.localPath}
                    </span>
                    {repo.remote && (
                      <span className="text-xs text-muted-foreground block truncate">
                        {repo.remote}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => handleRemoveRepo(repo.localPath)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Input
                  value={newRepoPath}
                  onChange={(e) => setNewRepoPath(e.target.value)}
                  placeholder="/path/to/local/repo"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addRepo(newRepoPath);
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setPickerOpen(true)}
                  title="Browse..."
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              <DirectoryPicker
                open={pickerOpen}
                onSelect={(path) => {
                  addRepo(path);
                  setPickerOpen(false);
                }}
                onCancel={() => setPickerOpen(false)}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4 border-t border-border">
            {isNew && (
              <Button onClick={handleCreate} disabled={!name.trim()}>
                Create Fleet
              </Button>
            )}
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
