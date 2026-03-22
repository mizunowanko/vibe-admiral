import { create } from "zustand";
import type { CommanderRole, RightPanelTab } from "@/types";

type MainView = "command" | "ships" | "fleet-settings";

interface UIState {
  mainView: MainView;
  activeCommanderTab: CommanderRole;
  rightPanelTab: RightPanelTab;
  viewingShipId: string | null;
  sidebarOpen: boolean;
  engineConnected: boolean;
  /** Per-role input drafts preserved across component remounts. */
  inputDrafts: Record<string, string>;

  setMainView: (view: MainView) => void;
  setActiveCommanderTab: (tab: CommanderRole) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setViewingShipId: (id: string | null) => void;
  toggleSidebar: () => void;
  setEngineConnected: (connected: boolean) => void;
  setInputDraft: (key: string, value: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  mainView: "command",
  activeCommanderTab: "flagship",
  rightPanelTab: "flagship",
  viewingShipId: null,
  sidebarOpen: true,
  engineConnected: false,
  inputDrafts: {},

  setMainView: (view) => set({ mainView: view }),
  setActiveCommanderTab: (tab) => set({ activeCommanderTab: tab }),
  setRightPanelTab: (tab) => {
    if (tab === "flagship" || tab === "dock") {
      set({ rightPanelTab: tab, activeCommanderTab: tab });
    } else {
      set({ rightPanelTab: tab });
    }
  },
  setViewingShipId: (id) => set({ viewingShipId: id }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setEngineConnected: (connected) => set({ engineConnected: connected }),
  setInputDraft: (key, value) =>
    set((s) => ({ inputDrafts: { ...s.inputDrafts, [key]: value } })),
}));
