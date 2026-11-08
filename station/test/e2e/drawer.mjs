// Shared by the station e2es: the queue/requests/owner tools live in one drawer behind the yellow "Request a song" tab.

/** Opens the drawer (if closed) and, for the owner, switches to a drawer tab: "Requests", "Add song" or "Owner tools". */
export async function openDrawer(page, tab) {
  const opener = page.getByRole("button", { name: /^(Request a song|Queue)$/ });
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

export const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The player is >= 200px tall and the open drawer covers no part of it. */
export async function playerClearOfDrawer(page) {
  const frame = await page.locator(".player-frame").boundingBox();
  const drawer = await page.locator(".drawer").boundingBox();
  return { frame, ok: frame.width >= 200 && frame.height >= 200 && !overlaps(frame, drawer) };
}
