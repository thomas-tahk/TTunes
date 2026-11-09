// Shared by the station e2es: the queue/requests/owner tools live in one drawer behind the "Request a song" tab.

/** Opens the header's Settings menu (if closed). Look, Layout and Panel radios only exist while it is open. */
export async function openSettings(page) {
  const button = page.getByRole("button", { name: "Settings" });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}

/** Opens the drawer (if closed) and, for the owner, switches to a drawer tab: "Requests", "Add song" or "Owner tools". */
export async function openDrawer(page, tab) {
  const opener = page.getByRole("button", { name: /^(Request a song|Requests)$/ });
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

export const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The player is >= 200px tall and the open drawer covers no part of it. */
export async function playerClearOfDrawer(page) {
  const frame = await page.locator(".player-host").boundingBox(); // inside the white border: the real video area
  const drawer = await page.locator(".drawer").boundingBox();
  return { frame, ok: frame.width >= 200 && frame.height >= 200 && !overlaps(frame, drawer) };
}

/** Every visible text field in the open drawer: its focus ring (box + outline-offset + outline-width) stays clear of its label. Returns the field ids checked and any that collide. */
export async function focusRingsClearOfLabels(page) {
  return page.evaluate(() => {
    const checked = [], bad = [];
    for (const el of document.querySelectorAll(".drawer input:not([type=radio]):not([type=checkbox]), .drawer textarea")) {
      const r = el.getBoundingClientRect();
      const label = el.id && document.querySelector(`label[for="${el.id}"]`);
      if (!r.width || !label) continue;
      el.focus();
      const cs = getComputedStyle(el);
      const grow = cs.outlineStyle === "none" ? 0 : Math.max(parseFloat(cs.outlineWidth) || 0, cs.outlineStyle === "auto" ? 3 : 0) + (parseFloat(cs.outlineOffset) || 0);
      const l = label.getBoundingClientRect();
      checked.push(el.id);
      if (cs.outlineStyle === "none" || r.top - grow < l.bottom) bad.push(`${el.id}: ring top ${(r.top - grow).toFixed(1)} < label bottom ${l.bottom.toFixed(1)} (outline ${cs.outlineStyle} ${cs.outlineWidth} offset ${cs.outlineOffset})`);
    }
    return { checked, bad };
  });
}

/** The video area is fully inside the viewport (not scrolled off by opening the drawer). */
export async function playerInViewport(page) {
  const box = await page.locator(".player-host").boundingBox();
  const { innerWidth, innerHeight } = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
  return { box, ok: box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth && box.y + box.height <= innerHeight };
}
