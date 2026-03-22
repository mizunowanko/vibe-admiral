import { useState, useEffect } from "react";
import { useFleetStore } from "@/stores/fleetStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings, Plus, Trash2, X, FolderOpen } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";
import type { FleetRepo, FleetSkillSources } from "@/types";

function PathListEditor({
  label,
  paths,
  onChange,
}: {
  label: string;
  paths: string[];
  onChange: (paths: string[]) => void;
}) {
  const [newPath, setNewPath] = useState("");

  const handleAdd = () => {
    const trimmed = newPath.trim();
    if (!trimmed || paths.includes(trimmed)) return;
    onChange([...paths, trimmed]);
    setNewPath("");
  };

  return (
    <div>
      <label className="text-sm font-medium mb-2 block">{label}</label>
      <div className="space-y-1">
        {paths.map((p) => (
          <div
            key={p}
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5"
          >
            <span className="text-xs font-mono flex-1 truncate">{p}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={() => onChange(paths.filter((x) => x !== p))}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="/path/to/rules.md"
            className="text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={!newPath.trim()}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FleetSettings() {
  const selectedFleet = useFleetStore((s) => s.selectedFleet);
  const createFleet = useFleetStore((s) => s.createFleet);
  const updateFleet = useFleetStore((s) => s.updateFleet);
  const deleteFleet = useFleetStore((s) => s.deleteFleet);

  const [name, setName] = useState(selectedFleet?.name ?? "");
  const [repos, setRepos] = useState<FleetRepo[]>(selectedFleet?.repos ?? []);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skillSources, setSkillSources] = useState<FleetSkillSources>(
    selectedFleet?.skillSources ?? {},
  );
  const [maxConcurrentSorties, setMaxConcurrentSorties] = useState<number>(
    selectedFleet?.maxConcurrentSorties ?? 6,
  );
  const [sharedRulePaths, setSharedRulePaths] = useState<string[]>(
    selectedFleet?.sharedRulePaths ?? [],
  );
  const [flagshipRulePaths, setFlagshipRulePaths] = useState<string[]>(
    selectedFleet?.flagshipRulePaths ?? selectedFleet?.bridgeRulePaths ?? [],
  );
  const [dockRulePaths, setDockRulePaths] = useState<string[]>(
    selectedFleet?.dockRulePaths ?? [],
  );
  const [shipRulePaths, setShipRulePaths] = useState<string[]>(
    selectedFleet?.shipRulePaths ?? [],
  );

  const isNew = !selectedFleet;

  useEffect(() => {
    setName(selectedFleet?.name ?? "");
    setRepos(selectedFleet?.repos ?? []);
    setNewRepoPath("");
    setSkillSources(selectedFleet?.skillSources ?? {});
    setMaxConcurrentSorties(selectedFleet?.maxConcurrentSorties ?? 6);
    setSharedRulePaths(selectedFleet?.sharedRulePaths ?? []);
    setFlagshipRulePaths(selectedFleet?.flagshipRulePaths ?? selectedFleet?.bridgeRulePaths ?? []);
    setDockRulePaths(selectedFleet?.dockRulePaths ?? []);
    setShipRulePaths(selectedFleet?.shipRulePaths ?? []);
  }, [selectedFleet]);

  const saveRepos = (nextRepos: FleetRepo[]) => {
    if (!isNew && name.trim()) {
      updateFleet(selectedFleet.id, { name: name.trim(), repos: nextRepos });
    }
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    createFleet(name.trim(), repos);
  };

  const handleSave = () => {
    if (!name.trim() || isNew) return;
    updateFleet(selectedFleet.id, {
      name: name.trim(),
      repos,
      skillSources,
      maxConcurrentSorties,
      sharedRulePaths,
      flagshipRulePaths,
      dockRulePaths,
      shipRulePaths,
    });
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
                  updateFleet(selectedFleet.id, { name: name.trim() });
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

          {/* Max Concurrent Sorties — only shown when editing */}
          {!isNew && (
            <div>
              <label className="text-sm font-medium mb-2 block">
                Max Concurrent Sorties
              </label>
              <p className="text-xs text-muted-foreground mb-2">
                Maximum number of Ships that can run simultaneously.
              </p>
              <Input
                type="number"
                min={1}
                max={20}
                value={maxConcurrentSorties}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val) && val >= 1 && val <= 20) {
                    setMaxConcurrentSorties(val);
                  }
                }}
                className="w-24"
              />
            </div>
          )}

          {/* Skill Sources — only shown when editing */}
          {!isNew && (
            <div>
              <label className="text-sm font-medium mb-2 block">
                Skill Sources
              </label>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    /implement skill directory
                  </label>
                  <Input
                    value={skillSources.implement ?? ""}
                    onChange={(e) =>
                      setSkillSources({
                        ...skillSources,
                        implement: e.target.value || undefined,
                      })
                    }
                    placeholder="Default: repo skills/implement/"
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    dev-shared skills directory
                  </label>
                  <Input
                    value={skillSources.devSharedDir ?? ""}
                    onChange={(e) =>
                      setSkillSources({
                        ...skillSources,
                        devSharedDir: e.target.value || undefined,
                      })
                    }
                    placeholder="e.g. ~/Projects/Plugins/dev-shared/plugins/shared-skills/skills/"
                    className="text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Behavioral Rules — only shown when editing */}
          {!isNew && (
            <div className="space-y-4">
              <h3 className="text-sm font-medium">Behavioral Rules</h3>
              <PathListEditor
                label="Shared Rules (Flagship + Dock + Ship)"
                paths={sharedRulePaths}
                onChange={setSharedRulePaths}
              />
              <PathListEditor
                label="Flagship-only Rules"
                paths={flagshipRulePaths}
                onChange={setFlagshipRulePaths}
              />
              <PathListEditor
                label="Dock-only Rules"
                paths={dockRulePaths}
                onChange={setDockRulePaths}
              />
              <PathListEditor
                label="Ship-only Rules"
                paths={shipRulePaths}
                onChange={setShipRulePaths}
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-4 border-t border-border">
            {isNew && (
              <Button onClick={handleCreate} disabled={!name.trim()}>
                Create Fleet
              </Button>
            )}
            {!isNew && (
              <>
                <Button onClick={handleSave}>
                  Save Settings
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => deleteFleet(selectedFleet.id)}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete Fleet
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
