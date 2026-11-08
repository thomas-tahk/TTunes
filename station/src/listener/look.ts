export type Look = "afterglow" | "theset";
export const LOOK_KEY = "ttunes.look";

/** The saved look for this browser; Afterglow when nothing is saved or storage is blocked. */
export function readLook(): Look {
  try {
    return localStorage.getItem(LOOK_KEY) === "theset" ? "theset" : "afterglow";
  } catch {
    return "afterglow";
  }
}

export function applyLook(look: Look) {
  document.documentElement.dataset.look = look;
  try {
    localStorage.setItem(LOOK_KEY, look);
  } catch {
    /* not remembered: the look still applies for this visit */
  }
}
