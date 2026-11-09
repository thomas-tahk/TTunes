import { type ReactNode, useEffect, useRef } from "react";

export type DrawerTab = "requests" | "add" | "tools";
/** "all": the Stacked layout shows every section in the page, so nothing is a tab. */
export type DrawerView = DrawerTab | "all";

const TABS: { id: DrawerTab; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "add", label: "Add song" },
  { id: "tools", label: "Owner tools" },
];

interface Props {
  open: boolean;
  owner: boolean;
  tab: DrawerView;
  stacked?: boolean;
  onTab: (tab: DrawerTab) => void;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}

/** One tab opens one drawer. Wide screens: it slides in from the right beside the player. Phones: it opens below the player, which stays on screen. */
export function Drawer({ open, owner, tab, stacked, onTab, onToggle, label, children }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const wasStacked = useRef(stacked);

  useEffect(() => {
    // Switching layout opens or hides the drawer without the user asking: leave focus and scroll where they are.
    const flipped = wasStacked.current !== stacked;
    wasStacked.current = stacked;
    if (flipped) {
      wasOpen.current = open;
      return;
    }
    if (open) {
      heading.current?.focus({ preventScroll: true });
      // Phones: the drawer sits below the player. Bring the player to the top so it stays on screen with the drawer under it.
      if (window.matchMedia("(max-width: 999px)").matches) (document.querySelector(".stage") ?? heading.current)?.scrollIntoView({ block: "start" });
    }
    else if (wasOpen.current) opener.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open, stacked]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onToggle();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const at = TABS.findIndex((t) => t.id === tab);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length];
    onTab(next.id);
    document.getElementById(`drawer-tab-${next.id}`)?.focus();
  }

  return (
    <>
      {!stacked && <button ref={opener} type="button" className="drawer-tab" aria-expanded={open} aria-controls="drawer" onClick={onToggle}>
        <span>{label}</span>
      </button>}
      <aside id="drawer" className="drawer" aria-label="Queue and requests" hidden={!open && !stacked}>
        <div className="drawer-head">
          <h2 ref={heading} tabIndex={-1}>
            Queue &amp; requests
          </h2>
          {!stacked && (
            <button type="button" className="drawer-close" onClick={onToggle}>
              Close
            </button>
          )}
        </div>
        {owner && !stacked && (
          <div role="tablist" aria-label="Drawer sections" className="drawer-tabs">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" tabIndex={tab === t.id ? 0 : -1} onKeyDown={onTabKey} id={`drawer-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`drawer-panel-${t.id}`} className={tab === t.id ? "drawer-tab-btn on" : "drawer-tab-btn"} onClick={() => onTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        {children}
      </aside>
    </>
  );
}

/** A section of the drawer. Hidden sections stay mounted so half-typed forms and polling survive a tab switch. */
export function DrawerPanel({ id, tab, owner, children }: { id: DrawerTab; tab: DrawerView; owner: boolean; children: ReactNode }) {
  const tabbed = owner && tab !== "all";
  return (
    <div role={tabbed ? "tabpanel" : undefined} id={`drawer-panel-${id}`} aria-labelledby={tabbed ? `drawer-tab-${id}` : undefined} className="drawer-panel" hidden={tab !== "all" && tab !== id}>
      {children}
    </div>
  );
}
