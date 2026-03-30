import "@testing-library/jest-dom/vitest";

// Zustand's persist middleware requires localStorage with getItem/setItem.
// jsdom may not provide a working implementation depending on the version,
// so we polyfill it here.
const store = new Map<string, string>();
const mockStorage: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
};

Object.defineProperty(globalThis, "localStorage", { value: mockStorage, writable: true });
