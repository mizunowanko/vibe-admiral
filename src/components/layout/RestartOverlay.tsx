import { useUIStore } from "@/stores/uiStore";
import { Loader2 } from "lucide-react";

export function RestartOverlay() {
  const engineRestarting = useUIStore((s) => s.engineRestarting);

  if (!engineRestarting) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card p-8 shadow-lg">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <div className="text-center">
          <p className="text-lg font-semibold">Engine Restarting...</p>
          <p className="mt-1 text-sm text-muted-foreground">
            All sessions will resume automatically after restart.
          </p>
        </div>
      </div>
    </div>
  );
}
