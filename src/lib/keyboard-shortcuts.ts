export type KeyboardShortcut = {
  keys: string[];
  description: string;
};

export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { keys: ["Ctrl", "1"], description: "Dock にフォーカス" },
  { keys: ["Ctrl", "2"], description: "Flagship にフォーカス" },
  { keys: ["Ctrl", "3~N"], description: "N番目の Ship にフォーカス" },
  { keys: ["?"], description: "ショートカット早見表を表示" },
  { keys: ["Ctrl", "/"], description: "ショートカット早見表を表示" },
];
