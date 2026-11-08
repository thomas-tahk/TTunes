import { type ReactNode, useEffect, useRef } from "react";

export type DrawerTab = "requests" | "add" | "tools";

const TABS: { id: DrawerTab; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "add", label: "Add song" },
  { id: "tools", label: "Owner tools" },
];

interface Props {
  open: boolean;
  owner: boolean;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}

/** One yellow tab opens one drawer. Wide screens: it slides in from the right beside the player. Phones: it opens below the player, which stays on screen. */
export function Drawer({ open, owner, tab, onTab, onToggle, label, children }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      heading.current?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 999px)").matches) heading.current?.scrollIntoView({ block: "start" }); // phones: the drawer sits below the player
    }
    else if (wasOpen.current) opener.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onToggle();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onToggle]);

  return (
    <>
      <button ref={opener} type="button" className="drawer-tab" aria-expanded={open} aria-controls="drawer" onClick={onToggle}>
        <span>{label}</span>
      </button>
      <aside id="drawer" className="drawer" aria-label="Queue and requests" hidden={!open}>
        <div className="drawer-head">
          <h2 ref={heading} tabIndex={-1}>
            Queue &amp; requests
          </h2>
          <button type="button" className="drawer-close" onClick={onToggle}>
            Close
          </button>
        </div>
        {owner && (
          <div role="tablist" aria-label="Drawer sections" className="drawer-tabs">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" id={`drawer-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`drawer-panel-${t.id}`} className={tab === t.id ? "drawer-tab-btn on" : "drawer-tab-btn"} onClick={() => onTab(t.id)}>
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
export function DrawerPanel({ id, tab, owner, children }: { id: DrawerTab; tab: DrawerTab; owner: boolean; children: ReactNode }) {
  return (
    <div role={owner ? "tabpanel" : undefined} id={`drawer-panel-${id}`} aria-labelledby={owner ? `drawer-tab-${id}` : undefined} className="drawer-panel" hidden={tab !== id}>
      {children}
    </div>
  );
}
