import { useFleetStore } from "@/stores/fleetStore";
import { useUIStore } from "@/stores/uiStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Anchor,
  Plus,
  Settings,
  Ship,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const fleets = useFleetStore((s) => s.fleets);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);
  const selectFleet = useFleetStore((s) => s.selectFleet);
  const mainView = useUIStore((s) => s.mainView);
  const setMainView = useUIStore((s) => s.setMainView);
  const engineConnected = useUIStore((s) => s.engineConnected);

  return (
    <div className="flex h-full w-60 flex-col border-r border-border bg-sidebar-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Anchor className="h-5 w-5 text-primary" />
        <h1 className="text-sm font-bold tracking-tight">vibe-admiral</h1>
        <div
          data-testid="engine-status"
          className={cn(
            "ml-auto h-2 w-2 rounded-full",
            engineConnected ? "bg-green-500" : "bg-red-500",
          )}
          title={engineConnected ? "Engine connected" : "Engine disconnected"}
        />
      </div>

      {/* Fleet List */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">
          Fleets
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            selectFleet(null);
            setMainView("fleet-settings");
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        {fleets.map((fleet) => (
          <button
            key={fleet.id}
            onClick={() => {
              selectFleet(fleet.id);
              setMainView("command");
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
              selectedFleetId === fleet.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent/50",
            )}
          >
            <Ship className="h-4 w-4 shrink-0" />
            <span className="truncate">{fleet.name}</span>
          </button>
        ))}
        {fleets.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground text-center">
            No fleets yet
          </p>
        )}
      </ScrollArea>

      {/* Settings */}
      <div className="border-t border-border p-2 space-y-1">
        {selectedFleetId && (
          <Button
            variant={mainView === "fleet-settings" ? "secondary" : "ghost"}
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => setMainView("fleet-settings")}
          >
            <Settings className="h-4 w-4" />
            Fleet Settings
          </Button>
        )}
        <Button
          variant={mainView === "admiral-settings" ? "secondary" : "ghost"}
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => setMainView("admiral-settings")}
        >
          <Anchor className="h-4 w-4" />
          Admiral Settings
        </Button>
      </div>
    </div>
  );
}
