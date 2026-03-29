import { useState, useEffect } from "react";
import { useAdmiralSettingsStore } from "@/stores/admiralSettingsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Settings, Plus, X, Moon } from "lucide-react";
import type { SettingsLayer, CustomInstructions, GatePhase, GateType, FleetGateSettings } from "@/types";
import { useUIStore } from "@/stores/uiStore";
import { wsClient } from "@/lib/ws-client";

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
            placeholder="e.g. src/**/*.test.ts"
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
      "auto-approve": "Automatically approves.",
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
      "auto-approve": "Automatically approves.",
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
      "auto-approve": "Automatically approves.",
      "plan-review": "",
    },
  },
];

const CI_FIELDS = [
  { key: "shared" as const, label: "Shared (all actors)", placeholder: "Instructions applied to all actors..." },
  { key: "dock" as const, label: "Dock", placeholder: "Dock-specific instructions..." },
  { key: "flagship" as const, label: "Flagship", placeholder: "Flagship-specific instructions..." },
  { key: "ship" as const, label: "Ship", placeholder: "Ship-specific instructions..." },
  { key: "escort" as const, label: "Escort", placeholder: "Escort-specific instructions..." },
] as const;

function SettingsLayerEditor({
  title,
  description,
  layer,
  onSave,
}: {
  title: string;
  description: string;
  layer: SettingsLayer;
  onSave: (layer: SettingsLayer) => void;
}) {
  const [customInstructions, setCustomInstructions] = useState<CustomInstructions>(
    layer.customInstructions ?? {},
  );
  const [gates, setGates] = useState<FleetGateSettings>(layer.gates ?? {});
  const [gatePrompts, setGatePrompts] = useState<Partial<Record<GateType, string>>>(
    layer.gatePrompts ?? {},
  );
  const [qaRequiredPaths, setQaRequiredPaths] = useState<string[]>(
    layer.qaRequiredPaths ?? [],
  );
  const [maxConcurrentSorties, setMaxConcurrentSorties] = useState<number | undefined>(
    layer.maxConcurrentSorties,
  );

  useEffect(() => {
    setCustomInstructions(layer.customInstructions ?? {});
    setGates(layer.gates ?? {});
    setGatePrompts(layer.gatePrompts ?? {});
    setQaRequiredPaths(layer.qaRequiredPaths ?? []);
    setMaxConcurrentSorties(layer.maxConcurrentSorties);
  }, [layer]);

  const handleSave = () => {
    onSave({
      customInstructions: Object.values(customInstructions).some(Boolean) ? customInstructions : undefined,
      gates: Object.keys(gates).length > 0 ? gates : undefined,
      gatePrompts: Object.values(gatePrompts).some(Boolean) ? gatePrompts : undefined,
      qaRequiredPaths: qaRequiredPaths.length > 0 ? qaRequiredPaths : undefined,
      maxConcurrentSorties,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>

      {/* Max Concurrent Sorties */}
      <div>
        <label className="text-sm font-medium mb-2 block">
          Max Concurrent Sorties
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Default maximum number of Ships that can run simultaneously.
        </p>
        <Input
          type="number"
          min={1}
          max={20}
          value={maxConcurrentSorties ?? ""}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            setMaxConcurrentSorties(!isNaN(val) && val >= 1 && val <= 20 ? val : undefined);
          }}
          placeholder="Not set"
          className="w-24"
        />
      </div>

      {/* Gate Settings */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium">Gate Settings</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Default gate configuration for all fleets.
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
                    setGates({ ...gates, [phase]: enabled ? false : true });
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
                      setGates({ ...gates, [phase]: e.target.value as GateType });
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
            </div>
          );
        })}
      </div>

      {/* QA Required Paths */}
      <PathListEditor
        label="QA Required Paths"
        paths={qaRequiredPaths}
        onChange={setQaRequiredPaths}
      />

      {/* Custom Instructions */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium">Custom Instructions</h4>
          <p className="text-xs text-muted-foreground mt-1">
            {title === "Global Settings"
              ? "These instructions are merged with each fleet's instructions at runtime."
              : "These instructions are copied into new fleets at creation time."}
          </p>
        </div>
        {CI_FIELDS.map(({ key, label, placeholder }) => (
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

      <Button onClick={handleSave}>Save {title}</Button>
    </div>
  );
}

export function AdmiralSettings() {
  const settings = useAdmiralSettingsStore((s) => s.settings);
  const updateGlobal = useAdmiralSettingsStore((s) => s.updateGlobal);
  const updateTemplate = useAdmiralSettingsStore((s) => s.updateTemplate);
  const caffeinateActive = useUIStore((s) => s.caffeinateActive);
  const [activeTab, setActiveTab] = useState<"global" | "template">("global");

  const caffeinateEnabled = settings.caffeinateEnabled !== false;

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Settings className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Admiral Settings</h2>
      </div>

      {/* Sleep Inhibition */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Moon className="h-4 w-4 text-muted-foreground" />
            <div>
              <label className="text-sm font-medium">Sleep Inhibition</label>
              <p className="text-xs text-muted-foreground">
                Prevent macOS sleep while Units are active (caffeinate)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {caffeinateActive && (
              <span className="text-xs text-amber-500 font-medium">Active</span>
            )}
            <button
              type="button"
              role="switch"
              aria-checked={caffeinateEnabled}
              onClick={() => {
                wsClient.send({
                  type: "admiral-settings:update",
                  data: { caffeinateEnabled: !caffeinateEnabled },
                });
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                caffeinateEnabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                  caffeinateEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-4">
        <button
          onClick={() => setActiveTab("global")}
          className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "global"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Global Settings
        </button>
        <button
          onClick={() => setActiveTab("template")}
          className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "template"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Fleet Default Template
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-lg">
          {activeTab === "global" && (
            <SettingsLayerEditor
              title="Global Settings"
              description="Applied to ALL fleets at runtime. Fleet-specific settings can override these values."
              layer={settings.global}
              onSave={updateGlobal}
            />
          )}
          {activeTab === "template" && (
            <SettingsLayerEditor
              title="Fleet Default Template"
              description="Copied into new fleets at creation time as initial values. Changes here do NOT affect existing fleets."
              layer={settings.template}
              onSave={updateTemplate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
