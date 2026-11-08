export type Layout = "side" | "stacked";
export const LAYOUT_KEY = "ttunes.layout";

/** The saved layout for this browser; Side when nothing is saved, the value is unknown, or storage is blocked. */
export function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "stacked" ? "stacked" : "side";
  } catch {
    return "side";
  }
}

export function applyLayout(layout: Layout) {
  document.documentElement.dataset.layout = layout;
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* not remembered: the layout still applies for this visit */
  }
}
