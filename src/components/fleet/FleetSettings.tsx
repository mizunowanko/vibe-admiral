import { useState, useEffect } from "react";
import { useFleetStore } from "@/stores/fleetStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings, Plus, Trash2, X, FolderOpen } from "lucide-react";
import { DirectoryPicker } from "./DirectoryPicker";
import { Textarea } from "@/components/ui/textarea";
import type { FleetRepo, FleetSkillSources, CustomInstructions, GatePhase, GateType, FleetGateSettings } from "@/types";

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

/** Gate phase display configuration. */
const GATE_PHASE_CONFIG: {
  phase: GatePhase;
  label: string;
  defaultType: GateType;
  availableTypes: GateType[];
  description: Record<GateType, string>;
}[] = [
  {
    phase: "plan-gate",
    label: "Planning Gate",
    defaultType: "plan-review",
    availableTypes: ["plan-review", "auto-approve"],
    description: {
      "plan-review": "Escort reviews the implementation plan before coding begins.",
      "auto-approve": "Automatically approves — no review.",
      "code-review": "",
      "playwright": "",
    },
  },
  {
    phase: "coding-gate",
    label: "Implementing Gate",
    defaultType: "code-review",
    availableTypes: ["code-review", "auto-approve"],
    description: {
      "code-review": "Escort reviews the PR for code quality and correctness.",
      "auto-approve": "Automatically approves — no review.",
      "plan-review": "",
      "playwright": "",
    },
  },
  {
    phase: "qa-gate",
    label: "Acceptance Test Gate",
    defaultType: "playwright",
    availableTypes: ["code-review", "playwright", "auto-approve"],
    description: {
      "playwright": "Escort runs Playwright E2E tests to verify UI behavior.",
      "code-review": "Escort reviews the code instead of running E2E tests.",
      "auto-approve": "Automatically approves — no review.",
      "plan-review": "",
    },
  },
];

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
  const [customInstructions, setCustomInstructions] = useState<CustomInstructions>(
    selectedFleet?.customInstructions ?? {},
  );
  const [gates, setGates] = useState<FleetGateSettings>(
    selectedFleet?.gates ?? {},
  );
  const [qaRequiredPaths, setQaRequiredPaths] = useState<string[]>(
    selectedFleet?.qaRequiredPaths ?? [],
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
    setCustomInstructions(selectedFleet?.customInstructions ?? {});
    setGates(selectedFleet?.gates ?? {});
    setQaRequiredPaths(selectedFleet?.qaRequiredPaths ?? []);
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
      customInstructions,
      gates,
      qaRequiredPaths,
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

          {/* Gate Settings — only shown when editing */}
          {!isNew && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium">Gate Settings</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Configure which review gates are active and their type for
                  each workflow phase.
                </p>
              </div>
              {GATE_PHASE_CONFIG.map(({ phase, label, defaultType, availableTypes, description }) => {
                const config = gates[phase];
                const enabled = config !== false;
                const currentType: GateType =
                  config === undefined || config === true
                    ? defaultType
                    : config === false
                      ? defaultType
                      : config;

                return (
                  <div
                    key={phase}
                    className="rounded-md border border-border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium">{label}</label>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={enabled}
                        onClick={() => {
                          setGates({
                            ...gates,
                            [phase]: enabled ? false : true,
                          });
                        }}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                          enabled ? "bg-primary" : "bg-muted"
                        }`}
                      >
                        <span
                          className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                            enabled ? "translate-x-4" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                    {enabled && (
                      <>
                        <select
                          value={currentType}
                          onChange={(e) => {
                            setGates({
                              ...gates,
                              [phase]: e.target.value as GateType,
                            });
                          }}
                          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs"
                        >
                          {availableTypes.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground">
                          {description[currentType]}
                        </p>
                      </>
                    )}
                    {!enabled && (
                      <p className="text-xs text-muted-foreground">
                        Disabled — ships will skip this gate automatically.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* QA Required Paths — only shown when editing */}
          {!isNew && (
            <PathListEditor
              label="QA Required Paths"
              paths={qaRequiredPaths}
              onChange={setQaRequiredPaths}
            />
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

          {/* Custom Instructions — only shown when editing */}
          {!isNew && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium">Custom Instructions</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Per-actor system prompt instructions. Shared instructions are
                  prepended to all actors.
                </p>
              </div>
              {([
                { key: "shared" as const, label: "Shared (all actors)", placeholder: "Instructions applied to Dock, Flagship, Ship, and Escort..." },
                { key: "dock" as const, label: "Dock", placeholder: "Dock-specific instructions..." },
                { key: "flagship" as const, label: "Flagship", placeholder: "Flagship-specific instructions..." },
                { key: "ship" as const, label: "Ship", placeholder: "Ship-specific instructions..." },
                { key: "escort" as const, label: "Escort", placeholder: "Escort-specific instructions..." },
              ] as const).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {label}
                  </label>
                  <Textarea
                    value={customInstructions[key] ?? ""}
                    onChange={(e) =>
                      setCustomInstructions({
                        ...customInstructions,
                        [key]: e.target.value || undefined,
                      })
                    }
                    placeholder={placeholder}
                    className="text-xs min-h-[80px] font-mono"
                    rows={3}
                  />
                </div>
              ))}
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
