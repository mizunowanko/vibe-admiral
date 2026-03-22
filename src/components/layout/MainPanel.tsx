import { useEffect, useCallback } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import {
  useSessionStore,
  commanderSessionId,
  createCommanderSession,
} from "@/stores/sessionStore";
import { SessionChat } from "@/components/session/SessionChat";
import { SessionCardList } from "@/components/session/SessionCardList";
import { ShipGrid } from "@/components/ship/ShipGrid";
import { FleetSettings } from "@/components/fleet/FleetSettings";

export function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId);
  const setFocus = useSessionStore((s) => s.setFocus);
  const registerSession = useSessionStore((s) => s.registerSession);

  // Register commander sessions when fleet changes and auto-focus flagship
  useEffect(() => {
    if (!selectedFleetId) return;
    registerSession(createCommanderSession("dock", selectedFleetId));
    registerSession(createCommanderSession("flagship", selectedFleetId));
    // Auto-focus flagship for this fleet if nothing focused
    const currentFocus = useSessionStore.getState().focusedSessionId;
    if (!currentFocus) {
      setFocus(commanderSessionId("flagship", selectedFleetId));
    }
  }, [selectedFleetId, registerSession, setFocus]);

  // Keyboard shortcuts: Ctrl+1 → Dock, Ctrl+2 → Flagship, Ctrl+3..N → Ships
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!selectedFleetId) return;
      if (!e.ctrlKey && !e.metaKey) return;

      const num = parseInt(e.key, 10);
      if (isNaN(num) || num < 1) return;

      e.preventDefault();

      if (num === 1) {
        setFocus(commanderSessionId("dock", selectedFleetId));
        return;
      }
      if (num === 2) {
        setFocus(commanderSessionId("flagship", selectedFleetId));
        return;
      }

      // Ctrl+3..N → focus Nth ship session
      // Read sessions at event time to avoid re-rendering MainPanel on every session change
      const sessions = useSessionStore.getState().sessions;
      const shipSessions = Array.from(sessions.values()).filter(
        (s) => s.type === "ship" && s.fleetId === selectedFleetId,
      );
      const shipIndex = num - 3;
      const target = shipSessions[shipIndex];
      if (shipIndex >= 0 && target) {
        setFocus(target.id);
      }
    },
    [selectedFleetId, setFocus],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!selectedFleetId && mainView !== "fleet-settings") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">Select or create a Fleet</p>
          <p className="text-sm mt-1">
            Choose a fleet from the sidebar to begin
          </p>
        </div>
      </div>
    );
  }

  switch (mainView) {
    case "command":
      return (
        <div className="flex flex-1 min-h-0">
          {/* Left: Session Chat */}
          <SessionChat sessionId={focusedSessionId} />

          {/* Right: Session Card List */}
          <SessionCardList fleetId={selectedFleetId!} />
        </div>
      );
    case "ships":
      return <ShipGrid fleetId={selectedFleetId} />;
    case "fleet-settings":
      return <FleetSettings />;
    default:
      return null;
  }
}
