import { create } from "zustand";
import type { CommanderRole } from "@/types";

type MainView = "command" | "ships" | "fleet-settings";

interface UIState {
  mainView: MainView;
  activeCommanderTab: CommanderRole;
  sidebarOpen: boolean;
  engineConnected: boolean;

  setMainView: (view: MainView) => void;
  setActiveCommanderTab: (tab: CommanderRole) => void;
  toggleSidebar: () => void;
  setEngineConnected: (connected: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  mainView: "command",
  activeCommanderTab: "flagship",
  sidebarOpen: true,
  engineConnected: false,

  setMainView: (view) => set({ mainView: view }),
  setActiveCommanderTab: (tab) => set({ activeCommanderTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setEngineConnected: (connected) => set({ engineConnected: connected }),
}));
