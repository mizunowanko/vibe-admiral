import { create } from "zustand";

type MainView = "bridge" | "ships" | "fleet-settings";

interface UIState {
  mainView: MainView;
  sidebarOpen: boolean;
  engineConnected: boolean;

  setMainView: (view: MainView) => void;
  toggleSidebar: () => void;
  setEngineConnected: (connected: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  mainView: "bridge",
  sidebarOpen: true,
  engineConnected: false,

  setMainView: (view) => set({ mainView: view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setEngineConnected: (connected) => set({ engineConnected: connected }),
}));
