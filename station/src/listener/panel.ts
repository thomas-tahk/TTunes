export type Panel = "dark" | "black" | "frosted" | "cream" | "yellow";
export const PANEL_KEY = "ttunes.panel";
export const PANELS: { id: Panel; label: string }[] = [
  { id: "dark", label: "Dark tinted" },
  { id: "black", label: "Neutral black" },
  { id: "frosted", label: "Frosted" },
  { id: "cream", label: "Cream" },
  { id: "yellow", label: "Yellow" },
];

const isPanel = (v: string | null): v is Panel => PANELS.some((p) => p.id === v);

/** The saved Afterglow panel colour for this browser; Dark tinted when nothing is saved, the value is unknown, or storage is blocked. */
export function readPanel(): Panel {
  try {
    const saved = localStorage.getItem(PANEL_KEY);
    return isPanel(saved) ? saved : "dark";
  } catch {
    return "dark";
  }
}

export function applyPanel(panel: Panel) {
  document.documentElement.dataset.panel = panel;
  try {
    localStorage.setItem(PANEL_KEY, panel);
  } catch {
    /* not remembered: the panel colour still applies for this visit */
  }
}
