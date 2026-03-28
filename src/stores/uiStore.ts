import { create } from "zustand";

type MainView = "command" | "fleet-settings" | "admiral-settings";

interface UIState {
  mainView: MainView;
  sidebarOpen: boolean;
  engineConnected: boolean;
  rateLimitActive: boolean;

  setMainView: (view: MainView) => void;
  toggleSidebar: () => void;
  setEngineConnected: (connected: boolean) => void;
  setRateLimitActive: (active: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  mainView: "command",
  sidebarOpen: true,
  engineConnected: false,
  rateLimitActive: false,

  setMainView: (view) => set({ mainView: view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setEngineConnected: (connected) => set({ engineConnected: connected }),
  setRateLimitActive: (active) => set({ rateLimitActive: active }),
}));
