import { useEffect, useCallback, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import {
  useSessionStore,
  commanderSessionId,
  createCommanderSession,
} from "@/stores/sessionStore";
import { SessionChat } from "@/components/session/SessionChat";
import { SessionCardList } from "@/components/session/SessionCardList";
import { FleetSettings } from "@/components/fleet/FleetSettings";
import { AdmiralSettings } from "@/components/admiral/AdmiralSettings";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

export function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId);
  const setFocus = useSessionStore((s) => s.setFocus);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Register commander sessions when fleet changes and auto-focus flagship
  useEffect(() => {
    if (!selectedFleetId) return;
    const { registerSession, setFocus: focus } = useSessionStore.getState();
    registerSession(createCommanderSession("dock", selectedFleetId));
    registerSession(createCommanderSession("flagship", selectedFleetId));
    // Always focus this fleet's Flagship when fleet changes
    focus(commanderSessionId("flagship", selectedFleetId), "fleet-change");
  }, [selectedFleetId]);

  // Keyboard shortcuts: Ctrl+1 → Dock, Ctrl+2 → Flagship, Ctrl+3..N → Ships, ? or Ctrl+/ → help
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // ? key (without modifier, not in input/textarea)
      if (
        e.key === "?" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if ((e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return;
      }

      // Ctrl+/ → toggle shortcuts dialog
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return;
      }

      // Navigation shortcuts require a selected fleet
      if (!selectedFleetId) return;
      if (!e.ctrlKey && !e.metaKey) return;

      const num = parseInt(e.key, 10);
      if (isNaN(num) || num < 1) return;

      e.preventDefault();

      if (num === 1) {
        setFocus(commanderSessionId("dock", selectedFleetId), "keyboard-shortcut");
        return;
      }
      if (num === 2) {
        setFocus(commanderSessionId("flagship", selectedFleetId), "keyboard-shortcut");
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
        setFocus(target.id, "keyboard-shortcut");
      }
    },
    [selectedFleetId, setFocus],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!selectedFleetId && mainView !== "fleet-settings" && mainView !== "admiral-settings") {
    return (
      <>
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">Select or create a Fleet</p>
            <p className="text-sm mt-1">
              Choose a fleet from the sidebar to begin
            </p>
          </div>
        </div>
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />
      </>
    );
  }

  const content = (() => {
    switch (mainView) {
      case "command":
        return (
          <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
            {/* Left: Session Chat */}
            <ResizablePanel defaultSize={65} minSize={30}>
              <SessionChat key={focusedSessionId ?? ''} sessionId={focusedSessionId} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            {/* Right: Session Card List */}
            <ResizablePanel defaultSize={35} minSize={20}>
              <SessionCardList fleetId={selectedFleetId!} />
            </ResizablePanel>
          </ResizablePanelGroup>
        );
      case "fleet-settings":
        return <FleetSettings />;
      case "admiral-settings":
        return <AdmiralSettings />;
      default:
        return null;
    }
  })();

  return (
    <>
      {content}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </>
  );
}
