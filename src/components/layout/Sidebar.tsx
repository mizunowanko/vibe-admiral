import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useFleetStore } from "@/stores/fleetStore";
import { useUIStore } from "@/stores/uiStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Anchor,
  GripVertical,
  Moon,
  Play,
  Plus,
  Settings,
  Ship,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { resumeAll } from "@/lib/api-client";
import type { Fleet } from "@/types";

function SortableFleetItem({
  fleet,
  isSelected,
  onSelect,
}: {
  fleet: Fleet;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: fleet.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm transition-colors",
        isSelected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none p-0.5 text-muted-foreground hover:text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      <Ship className="h-4 w-4 shrink-0" />
      <span className="truncate">{fleet.name}</span>
    </button>
  );
}

export function Sidebar() {
  const fleets = useFleetStore((s) => s.fleets);
  const fleetOrder = useFleetStore((s) => s.fleetOrder);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);
  const selectFleet = useFleetStore((s) => s.selectFleet);
  const reorderFleets = useFleetStore((s) => s.reorderFleets);

  const orderedFleets = useMemo(() => {
    const orderMap = new Map(fleetOrder.map((id, i) => [id, i]));
    return [...fleets].sort((a, b) => {
      const aIdx = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bIdx = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return aIdx - bIdx;
    });
  }, [fleets, fleetOrder]);
  const mainView = useUIStore((s) => s.mainView);
  const setMainView = useUIStore((s) => s.setMainView);
  const engineConnected = useUIStore((s) => s.engineConnected);
  const caffeinateActive = useUIStore((s) => s.caffeinateActive);

  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeStatus, setResumeStatus] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderFleets(String(active.id), String(over.id));
    },
    [reorderFleets],
  );

  const handleResumeAll = useCallback(async () => {
    setResumeLoading(true);
    setResumeStatus(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      const { summary } = await resumeAll();
      if (summary.resumed === 0 && summary.errors === 0) {
        setResumeStatus("No paused units");
      } else if (summary.errors > 0) {
        setResumeStatus(
          `Resumed ${summary.resumed}, ${summary.errors} error(s)`,
        );
      } else {
        setResumeStatus(`Resumed ${summary.resumed} unit(s)`);
      }
    } catch (err) {
      setResumeStatus(
        `Error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setResumeLoading(false);
      timerRef.current = setTimeout(() => setResumeStatus(null), 5000);
    }
  }, []);

  return (
    <div className="flex h-full flex-col border-r border-border bg-sidebar-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Anchor className="h-5 w-5 text-primary" />
        <h1 className="text-sm font-bold tracking-tight">vibe-admiral</h1>
      </div>

      {/* ── Upper: Fleets Section ── */}
      <div className="flex min-h-0 flex-1 flex-col">
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedFleets.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              {orderedFleets.map((fleet) => (
                <SortableFleetItem
                  key={fleet.id}
                  fleet={fleet}
                  isSelected={selectedFleetId === fleet.id}
                  onSelect={() => {
                    selectFleet(fleet.id);
                    setMainView("command");
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
          {orderedFleets.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground text-center">
              No fleets yet
            </p>
          )}
        </ScrollArea>

        {selectedFleetId && (
          <div className="px-2 pb-2">
            <Button
              variant={mainView === "fleet-settings" ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => setMainView("fleet-settings")}
            >
              <Settings className="h-4 w-4" />
              Fleet Settings
            </Button>
          </div>
        )}
      </div>

      {/* ── Lower: Admiral Section ── */}
      <div className="border-t border-border p-2 space-y-1">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="text-xs font-medium text-muted-foreground uppercase">
            Admiral
          </span>
          {caffeinateActive && (
            <span className="ml-auto" title="Sleep inhibited (caffeinate)">
              <Moon className="h-3 w-3 text-amber-500" />
            </span>
          )}
          <div
            data-testid="engine-status"
            className={cn(
              caffeinateActive ? "ml-1" : "ml-auto",
              "h-2 w-2 rounded-full",
              engineConnected ? "bg-green-500" : "bg-red-500",
            )}
            title={engineConnected ? "Engine connected" : "Engine disconnected"}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={!engineConnected || resumeLoading}
          onClick={handleResumeAll}
        >
          <Play className="h-4 w-4" />
          {resumeLoading ? "Resuming..." : "Resume All"}
        </Button>
        {resumeStatus && (
          <p className="px-2 text-xs text-muted-foreground">{resumeStatus}</p>
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
