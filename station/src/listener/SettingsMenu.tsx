import { useRef, useState } from "react";
import { LayoutSwitch } from "./LayoutSwitch.tsx";
import type { Layout } from "./layout.ts";
import { type Look, readLook } from "./look.ts";
import { LookSwitch } from "./LookSwitch.tsx";
import { PanelSwitch } from "./PanelSwitch.tsx";
import { type Panel, readPanel } from "./panel.ts";

const GEAR = "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";

/** The header's one "Settings" button: a disclosure that opens the per-browser choices (Look, Layout, and Panel while Afterglow is on).
 *  The panel is in the page flow under the header, so it never floats over the player; Escape closes it and puts focus back on the button. */
export function SettingsMenu({ layout, onLayout }: { layout: Layout; onLayout: (next: Layout) => void }) {
  const [open, setOpen] = useState(false);
  const [look, setLook] = useState<Look>(readLook);
  const [panel, setPanel] = useState<Panel>(readPanel);
  const button = useRef<HTMLButtonElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation(); // the request drawer's own Escape must not also fire
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="settings" onKeyDown={onKeyDown}>
      <button ref={button} type="button" className="settings-btn" aria-expanded={open} aria-controls="settings-panel" onClick={() => setOpen(!open)}>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d={GEAR} />
        </svg>
        <span className="settings-label">Settings</span>
      </button>
      {open && (
        <div id="settings-panel" className="settings-panel">
          <LookSwitch look={look} onChange={setLook} />
          <LayoutSwitch layout={layout} onChange={onLayout} />
          {look === "afterglow" && <PanelSwitch panel={panel} onChange={setPanel} />}
        </div>
      )}
    </div>
  );
}
