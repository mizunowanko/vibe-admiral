import { create } from "zustand";

type MainView = "command" | "fleet-settings" | "admiral-settings";

export interface PreviousCrashInfo {
  timestamp: string;
  context: string;
  message: string;
  stack?: string;
}

interface UIState {
  mainView: MainView;
  sidebarOpen: boolean;
  engineConnected: boolean;
  rateLimitActive: boolean;
  previousCrash: PreviousCrashInfo | null;

  setMainView: (view: MainView) => void;
  toggleSidebar: () => void;
  setEngineConnected: (connected: boolean) => void;
  setRateLimitActive: (active: boolean) => void;
  setPreviousCrash: (crash: PreviousCrashInfo | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  mainView: "command",
  sidebarOpen: true,
  engineConnected: false,
  rateLimitActive: false,
  previousCrash: null,

  setMainView: (view) => set({ mainView: view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setEngineConnected: (connected) => set({ engineConnected: connected }),
  setRateLimitActive: (active) => set({ rateLimitActive: active }),
  setPreviousCrash: (crash) => set({ previousCrash: crash }),
}));
