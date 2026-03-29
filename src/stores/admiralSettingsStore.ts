import { create } from "zustand";
import type { AdmiralSettings, SettingsLayer } from "@/types";
import { wsClient } from "@/lib/ws-client";

interface AdmiralSettingsState {
  settings: AdmiralSettings;

  setSettings: (settings: AdmiralSettings) => void;
  updateGlobal: (global: SettingsLayer) => void;
  updateTemplate: (template: SettingsLayer) => void;
  fetchSettings: () => void;
}

export const useAdmiralSettingsStore = create<AdmiralSettingsState>((set) => ({
  settings: { global: {}, template: {} },

  setSettings: (settings) => set({ settings }),

  updateGlobal: (global) => {
    wsClient.send({ type: "admiral-settings:update", data: { global } });
  },

  updateTemplate: (template) => {
    wsClient.send({ type: "admiral-settings:update", data: { template } });
  },

  fetchSettings: () => {
    wsClient.send({ type: "admiral-settings:get" });
  },
}));
